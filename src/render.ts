import { env } from 'bun';
import {
	type Animation,
	type Sprite,
	type Shape,
	type FrameData,
	type Action,
	type AnimationType
} from '../src/types.ts';
import { readAnimation } from '../src/parser.ts';
import { type Canvas, type CanvasRenderingContext2D, createCanvas, Image, loadImage } from 'canvas';
import ffmpeg from 'fluent-ffmpeg';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { dirSync, setGracefulCleanup } from 'tmp';

setGracefulCleanup();

type ColorTransformKind = 'Multiply' | 'Add' | 'Combine';
type Color = [number, number, number, number];

const DEFAULT_SCALE = 2;
const FRAME_PADDING = 16;

class ColorTransform {
	constructor(
		public kind: ColorTransformKind,
		public transform: Color,
		public combinedColors?: [ColorTransform, ColorTransform]
	) {}

	static identity() {
		return new ColorTransform('Add', [0, 0, 0, 0]);
	}

	combine(other: ColorTransform) {
		if (this.kind === 'Multiply' && other.kind === 'Multiply') {
			return new ColorTransform('Multiply', [
				this.transform[0] * other.transform[0],
				this.transform[1] * other.transform[1],
				this.transform[2] * other.transform[2],
				this.transform[3] * other.transform[3]
			]);
		} else if (this.kind === 'Add' && other.kind === 'Add') {
			return new ColorTransform('Add', [
				this.transform[0] + other.transform[0],
				this.transform[1] + other.transform[1],
				this.transform[2] + other.transform[2],
				this.transform[3] + other.transform[3]
			]);
		}
		return new ColorTransform('Combine', [0, 0, 0, 0], [this, other]);
	}

	fold(color: Color): Color {
		if (this.kind === 'Multiply') {
			return [
				this.transform[0] * color[0],
				this.transform[1] * color[1],
				this.transform[2] * color[2],
				this.transform[3] * color[3]
			];
		} else if (this.kind === 'Add') {
			return [
				this.transform[0] + color[0],
				this.transform[1] + color[1],
				this.transform[2] + color[2],
				this.transform[3] + color[3]
			];
		}
		return this.combinedColors![0].fold(this.combinedColors![1].fold(color));
	}

	intoColor(): Color {
		return this.fold([1, 1, 1, 1]);
	}
}

type Point2D = { x: number; y: number };

class Box2D {
	constructor(
		public min: Point2D,
		public max: Point2D
	) {}

	static fromOriginAndSize(x: number, y: number, width: number, height: number) {
		return new Box2D({ x, y }, { x: x + width, y: y + height });
	}

	isEmpty() {
		return !(this.max.x > this.min.x && this.max.y > this.min.y);
	}

	union(other: Box2D) {
		if (other.isEmpty()) {
			return this;
		}
		if (this.isEmpty()) {
			return other;
		}
		return new Box2D(
			{ x: Math.min(this.min.x, other.min.x), y: Math.min(this.min.y, other.min.y) },
			{ x: Math.max(this.max.x, other.max.x), y: Math.max(this.max.y, other.max.y) }
		);
	}

	width() {
		return this.max.x - this.min.x;
	}

	height() {
		return this.max.y - this.min.y;
	}

	size() {
		return { width: this.width(), height: this.height() };
	}

	center(): Point2D {
		return { x: (this.min.x + this.max.x) / 2, y: (this.min.y + this.max.y) / 2 };
	}

	inflate(width: number, heigth: number) {
		return new Box2D(
			{ x: this.min.x - width, y: this.min.y - heigth },
			{ x: this.max.x + width, y: this.max.y + heigth }
		);
	}
}

/**
 * euclid/transform2d.rs#Transform2D
 * 2D matrix
 * m11 m12
 * m21 m22
 * m31 m32
 */
class Transform2D {
	constructor(
		public m11: number,
		public m12: number,
		public m21: number,
		public m22: number,
		public m31: number,
		public m32: number
	) {}

	static identity() {
		return new Transform2D(1, 0, 0, 1, 0, 0);
	}

	static translate(x: number, y: number) {
		return new Transform2D(1, 0, 0, 1, x, y);
	}

	static rotate(x0: number, y0: number, x1: number, y1: number) {
		return new Transform2D(x0, y0, x1, y1, 0, 0);
	}

	static scale(x: number, y: number) {
		return new Transform2D(x, 0, 0, y, 0, 0);
	}

	mult(other: Transform2D) {
		return new Transform2D(
			this.m11 * other.m11 + this.m12 * other.m21,
			this.m11 * other.m12 + this.m12 * other.m22,
			this.m21 * other.m11 + this.m22 * other.m21,
			this.m21 * other.m12 + this.m22 * other.m22,
			this.m31 * other.m11 + this.m32 * other.m21 + other.m31,
			this.m31 * other.m12 + this.m32 * other.m22 + other.m32
		);
	}

	transformPoint(p: Point2D): Point2D {
		return {
			x: p.x * this.m11 + p.y * this.m21 + this.m31,
			y: p.x * this.m12 + p.y * this.m22 + this.m32
		};
	}

	/**
	 * Returns the smallest box containing all of the provided points.
	 */
	outerTransformedBox(box: Box2D): Box2D {
		const points = [
			this.transformPoint(box.min),
			this.transformPoint(box.max),
			this.transformPoint({ x: box.max.x, y: box.min.y }),
			this.transformPoint({ x: box.min.x, y: box.max.y })
		];

		const xs = points.map((p) => p.x);
		const ys = points.map((p) => p.y);

		return new Box2D(
			{ x: Math.min(...xs), y: Math.min(...ys) },
			{ x: Math.max(...xs), y: Math.max(...ys) }
		);
	}

	toArray() {
		return [this.m11, this.m12, this.m21, this.m22, this.m31, this.m32] as const;
	}
}

class SpriteTransform {
	constructor(
		public position: Transform2D,
		public color: ColorTransform
	) {}

	static identity() {
		return new SpriteTransform(Transform2D.identity(), ColorTransform.identity());
	}

	combine(other: SpriteTransform) {
		return new SpriteTransform(
			this.position.mult(other.position),
			this.color.combine(other.color)
		);
	}

	static translate(x: number, y: number) {
		return new SpriteTransform(Transform2D.translate(x, y), ColorTransform.identity());
	}

	static rotate(x0: number, y0: number, x1: number, y1: number) {
		return new SpriteTransform(Transform2D.rotate(x0, y0, x1, y1), ColorTransform.identity());
	}

	static scale(x: number, y: number) {
		return new SpriteTransform(Transform2D.scale(x, y), ColorTransform.identity());
	}

	static colorMultiply(r: number, g: number, b: number, alpha: number) {
		return new SpriteTransform(
			Transform2D.identity(),
			new ColorTransform('Multiply', [r, g, b, alpha])
		);
	}

	static colorAdd(r: number, g: number, b: number, alpha: number) {
		return new SpriteTransform(
			Transform2D.identity(),
			new ColorTransform('Add', [r, g, b, alpha])
		);
	}
}

class TransformTable {
	constructor(
		public colors: number[],
		public rotations: number[],
		public translations: number[],
		public actions: Action[]
	) {}

	static default() {
		return new TransformTable([], [], [], []);
	}
}

class FrameReader {
	constructor(
		public data: FrameData,
		public transformTable: TransformTable,
		public position: number = 0
	) {}

	seek(position: number) {
		this.position = position;
	}

	read() {
		const tag = this.readInt();
		if (tag === 0) {
			return SpriteTransform.identity();
		} else if (tag === 1) {
			return this.readRotation();
		} else if (tag === 2) {
			return this.readTranslation();
		} else if (tag === 3) {
			return this.readRotation().combine(this.readTranslation());
		} else if (tag === 4) {
			return this.readColorMultiply();
		} else if (tag === 5) {
			return this.readColorMultiply().combine(this.readRotation());
		} else if (tag === 6) {
			return this.readColorMultiply().combine(this.readTranslation());
		} else if (tag === 7) {
			return this.readColorMultiply()
				.combine(this.readRotation())
				.combine(this.readTranslation());
		} else if (tag === 8) {
			return this.readColorAdd();
		} else if (tag === 9) {
			return this.readColorAdd().combine(this.readRotation());
		} else if (tag === 10) {
			return this.readColorAdd().combine(this.readTranslation());
		} else if (tag === 11) {
			return this.readColorAdd().combine(this.readRotation()).combine(this.readTranslation());
		} else if (tag === 12) {
			return this.readColorMultiply().combine(this.readColorAdd());
		} else if (tag === 13) {
			return this.readColorMultiply()
				.combine(this.readColorAdd())
				.combine(this.readRotation());
		} else if (tag === 14) {
			return this.readColorMultiply()
				.combine(this.readColorAdd())
				.combine(this.readTranslation());
		} else if (tag === 15) {
			return this.readColorMultiply()
				.combine(this.readColorAdd())
				.combine(this.readRotation())
				.combine(this.readTranslation());
		}
		return null;
	}

	readInt() {
		let res: number;
		if (this.data.kind === 'Ints') {
			res = this.data.buffer[this.position]!;
		} else if (this.data.kind === 'Shorts') {
			res = this.data.buffer[this.position]!;
		} /* if (this.data.kind === "Bytes") */ else {
			res = this.data.buffer[this.position]!;
		}
		this.position += 1;
		return res;
	}

	readTranslation() {
		const offset = this.readInt();
		const x = this.transformTable.translations[offset]!;
		const y = this.transformTable.translations[offset + 1]!;
		return SpriteTransform.translate(x, y);
	}

	readRotation() {
		const offset = this.readInt();
		const x0 = this.transformTable.rotations[offset]!;
		const x1 = this.transformTable.rotations[offset + 1]!;
		const y0 = this.transformTable.rotations[offset + 2]!;
		const y1 = this.transformTable.rotations[offset + 3]!;
		return SpriteTransform.rotate(x0, x1, y0, y1);
	}

	readColorMultiply() {
		const offset = this.readInt();
		const r = this.transformTable.colors[offset]!;
		const g = this.transformTable.colors[offset + 1]!;
		const b = this.transformTable.colors[offset + 2]!;
		const a = this.transformTable.colors[offset + 3]!;
		return SpriteTransform.colorMultiply(r, g, b, a);
	}

	readColorAdd() {
		const offset = this.readInt();
		const r = this.transformTable.colors[offset]!;
		const g = this.transformTable.colors[offset + 1]!;
		const b = this.transformTable.colors[offset + 2]!;
		const a = this.transformTable.colors[offset + 3]!;
		return SpriteTransform.colorAdd(r, g, b, a);
	}
}

class Renderer {
	canvas!: Canvas;
	context!: CanvasRenderingContext2D;

	constructor(
		public texture: Image,
		canvasSize: { width: number; height: number }
	) {
		this.canvas = createCanvas(canvasSize.width, canvasSize.height);
		this.context = this.canvas.getContext('2d');
		this.context.globalCompositeOperation = 'source-over';
		this.context.antialias = 'subpixel';
		this.context.imageSmoothingEnabled = true;
		this.context.patternQuality = 'bilinear';
	}

	renderTexture(
		texture: Image | Canvas,
		crop: { x: number; y: number; width: number; height: number },
		dest: { x: number; y: number; width: number; height: number },
		transform: SpriteTransform
	): void {
		// Transform parameters
		const [x0, y0, x1, y1, x2, y2] = transform.position.toArray();
		const color = transform.color.intoColor();

		// Canvas render
		this.context.save();
		// Apply transform matrix
		this.context.transform(x0, y0, x1, y1, x2, y2);
		// Flip vertically (flip_y = true)
		this.context.scale(1, -1);
		// Apply global alpha
		this.context.globalAlpha = color[3];

		// Draw the image
		this.context.drawImage(
			texture,
			crop.x,
			crop.y,
			crop.width,
			crop.height,
			dest.x,
			dest.y,
			dest.width,
			dest.height
		);

		// Apply color tint
		// e.g 153302469.anm
		const isGrayscale = color[0] === color[1] && color[1] === color[2];
		const isFullyTransparent = color[3] === 0;
		if (!isGrayscale && !isFullyTransparent) {
			this.context.globalCompositeOperation = 'multiply';
			this.context.fillStyle = `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${color[3]})`;
			this.context.fillRect(dest.x, dest.y, dest.width, dest.height);
			this.context.globalCompositeOperation = 'source-over';
		}

		// Debug, trace the sprite boundaries
		// this.context.strokeStyle = "red";
		// this.context.strokeRect(shape.offset_x, -(shape.offset_y + shape.height), shape.width, shape.height);
		this.context.restore();
	}

	/**
	 * renderer/src/notan.rs#render
	 */
	render(animationRenderer: AnimationRenderer, shape: Shape, transform: SpriteTransform): void {
		// console.log("render shape", shape, transform.position.toArray());
		const { texture } = animationRenderer;

		const crop = {
			x: shape.left * texture.width,
			y: shape.top * texture.height,
			width: (shape.right - shape.left) * texture.width,
			height: (shape.bottom - shape.top) * texture.height
		};
		const dest = {
			x: shape.offset_x,
			y: -shape.offset_y - shape.height, // y flipped
			width: shape.width,
			height: shape.height
		};

		return this.renderTexture(texture, crop, dest, transform);
	}

	/**
	 * renderer/src/render.rs#render_by_id
	 */
	renderById(
		animation: AnimationRenderer,
		id: number,
		parent: SpriteTransform,
		reader: FrameReader,
		frame: number
	) {
		// console.log("render id", id, parent.position.toArray());
		const transform = reader.read();
		if (!transform) {
			throw new Error('Transform not found');
		}
		const finalTransform = transform.combine(parent);
		const sprite = animation.findSpriteById(id);
		if (sprite) {
			return this.renderSprite(sprite, finalTransform, frame);
		}
		const parentSprite = animation.parent?.findSpriteById(id);
		if (parentSprite) {
			return this.renderSprite(parentSprite, finalTransform, frame);
		}
		const shape = animation.animation.shapes.find((s) => s.id === id);
		if (shape) {
			return this.render(animation, shape, finalTransform);
		}
	}

	/**
	 * renderer/src/render.rs#render_sprite
	 */
	renderSprite(spriteReference: AnimationSprite, transform: SpriteTransform, frame: number) {
		// console.log("render sprite", spriteReference.sprite.name.name, transform.position.toArray());
		const { animation, sprite } = spriteReference;
		const transformTable = animation.animation.transform
			? animation.animation.transform
			: TransformTable.default();
		const reader = new FrameReader(sprite.frameData, transformTable, 0);
		if (sprite.payload.kind === 'Single' || sprite.payload.kind === 'SingleNoAction') {
			this.renderById(animation, sprite.payload.spriteId, transform, reader, frame);
			return;
		} else if (sprite.payload.kind === 'SingleFrame') {
			for (let index = 0; index < sprite.payload.spriteIds.length; index++) {
				const spriteId = sprite.payload.spriteIds[index]!;
				this.renderById(animation, spriteId, transform, reader, frame);
			}
			return;
		} else if (sprite.payload.kind === 'Frames') {
			const mult = sprite.payload.actionInfo.length === 0 ? 2 : 3;
			const frameCount = sprite.payload.framePos.length / mult;
			const index = (frame % frameCount) * mult;
			const offset = sprite.payload.framePos[index]!;
			const current = sprite.payload.framePos[index + 1]!;
			const count = sprite.payload.spriteInfo[current]!;
			reader.seek(offset);
			// skip current + 1 (slice start at current + 1) take count (slice until current + 1 + count)
			const spriteIter = sprite.payload.spriteInfo.slice(current + 1, current + 1 + count);
			for (let index = 0; index < spriteIter.length; index++) {
				const spriteId = spriteIter[index]!;
				this.renderById(animation, spriteId, transform, reader, frame);
			}
		}
	}
}

class Measurer extends Renderer {
	bbox: Box2D = new Box2D({ x: 0, y: 0 }, { x: 0, y: 0 });

	constructor() {
		super(new Image(), { width: 0, height: 0 });
	}

	render(_animation: AnimationRenderer, shape: Shape, transform: SpriteTransform): void {
		const rect = Box2D.fromOriginAndSize(
			shape.offset_x,
			shape.offset_y,
			shape.width,
			shape.height
		);
		this.bbox = transform.position.outerTransformedBox(rect).union(this.bbox);
	}

	static measureSprite(sprite: AnimationSprite, scale: number): Box2D {
		const frames = countFrames(sprite.sprite);
		const measurer = new Measurer();
		for (let frame = 0; frame < frames; frame++) {
			measurer.renderSprite(sprite, SpriteTransform.scale(scale, scale), frame);
		}
		return measurer.bbox;
	}

	static measureFrame(sprite: AnimationSprite, scale: number, frame: number): Box2D {
		const measurer = new Measurer();
		measurer.renderSprite(sprite, SpriteTransform.scale(scale, scale), frame);
		return measurer.bbox;
	}
}

function countFrames(sprite: Sprite): number {
	const payload = sprite.payload;
	if (payload.kind === 'Frames') {
		const divisor = payload.actionInfo.length === 0 ? 2 : 3;
		return payload.framePos.length / divisor;
	}
	return 1;
}

const staticSpriteFinder = [
	/1_AnimStatique-Boucle$/,
	/1_AnimStatic-Boucle$/,
	/1_AnimStatique$/,
	/1_AnimStatic$/,
	/1_AnimStatique/,
	/1_AnimStatic/,
	/1_AnimMarche/
];

type AnimationSprite = {
	name: string;
	animation: AnimationRenderer;
	sprite: Sprite;
	reference: number;
};

export class AnimationRenderer {
	constructor(
		public animation: Animation,
		public texture: Image,
		public references: AnimationRenderer[] = [],
		public parent: AnimationRenderer | null = null
	) {}

	static async loadTexture(animation: Animation) {
		const texture = await readFile(
			join(env.GAME_PATH!, `animations/npcs/Atlas/${animation.texture!.name}.png`)
		);
		return await loadImage(texture);
	}

	static async fromFile(type: AnimationType, id: number | string) {
		const animationFile = await readFile(join(env.GAME_PATH!, `animations/${type}/${id}.anm`));
		const animation = readAnimation(animationFile);
		const references: AnimationRenderer[] = [];
		// Load used animation files
		// -- some animations (e.g 104701363) have reference to other animation files that are used
		if (animation.index?.file_names?.length) {
			for (let index = 0; index < animation.index.file_names.length; index++) {
				const animationFile = animation.index.file_names[index]!;
				const subAnimation = await AnimationRenderer.fromFile(
					type,
					animationFile!.replace('.anm', '')
				);
				references.push(subAnimation);
			}
		}
		let texture = new Image();
		if (animation.texture) {
			texture = await AnimationRenderer.loadTexture(animation);
		}
		const animationRenderer = new AnimationRenderer(animation, texture, references);
		for (let index = 0; index < animationRenderer.references.length; index++) {
			const reference = animationRenderer.references[index]!;
			reference.parent = animationRenderer;
		}
		return animationRenderer;
	}

	get hasTexture() {
		return this.texture.width > 0;
	}

	get availableSprites() {
		return [
			...(this.animation.index?.animation_files?.map((f) => f.name) ?? []),
			...this.animation.sprites.map((s) => s.name.name)
		];
	}

	loadSprite(spriteName: string): AnimationSprite | null {
		const sprite = this.animation.sprites.find((s) => s.name.name === spriteName);
		if (sprite) {
			return { animation: this, name: spriteName, sprite, reference: -1 };
		}
		for (let index = 0; index < this.references.length; index++) {
			const reference = this.references[index]!;
			const spriteFromReference = reference.loadSprite(spriteName);
			if (spriteFromReference) {
				return spriteFromReference;
			}
		}
		return null;
	}

	findStaticSprite(): AnimationSprite | null {
		// Find the first sprite that matches any of the static sprite patterns
		for (let index = 0; index < staticSpriteFinder.length; index++) {
			const spriteFinder = staticSpriteFinder[index]!;
			const sprite = this.animation.sprites.find(
				(s) => s.name.name && spriteFinder.test(s.name.name)
			);
			if (sprite) {
				return { ...this.loadSprite(sprite.name.name!)!, reference: -1 };
			}
		}
		if (this.references.length) {
			for (let index = 0; index < this.references.length; index++) {
				const reference = this.references[index]!;
				const sprite = reference.findStaticSprite();
				if (sprite) {
					return { ...reference.loadSprite(sprite.name)!, reference: index };
				}
			}
		}
		return null;
	}

	findSpriteById(id: number): AnimationSprite | null {
		const sprite = this.animation.sprites.find((s) => s.id === id);
		if (sprite) {
			return { ...this.loadSprite(sprite.name.name!)!, reference: -1 };
		}
		return null;
	}

	get scale() {
		return (this.animation.index?.scale ?? 1) * DEFAULT_SCALE;
	}

	renderFrame(sprite: AnimationSprite, measurement: Box2D, frame: number) {
		const { width, height } = measurement.size();
		const center = measurement.center();
		const translationTransform = SpriteTransform.translate(
			width / 2 - center.x,
			height / 2 - center.y
		);
		const scaleTransform = SpriteTransform.scale(this.scale, this.scale);
		const defaultTransform = scaleTransform.combine(translationTransform);
		const renderer = new Renderer(this.texture, measurement.size());
		renderer.renderSprite(sprite, defaultTransform, frame);
		return renderer.canvas;
	}

	renderFrameAsImage(sprite: AnimationSprite, measurement: Box2D, frame: number) {
		const canvas = this.renderFrame(sprite, measurement, frame);
		const image = canvas.toBuffer('image/png');
		return image;
	}

	renderForImport(sprite: AnimationSprite) {
		// console.log("Render sprite", this.sprite.name.name, "to image");
		const spriteMeasure = Measurer.measureFrame(sprite, this.scale, 0);
		return this.renderFrame(sprite, spriteMeasure.inflate(FRAME_PADDING, FRAME_PADDING), 0);
	}

	renderImage(sprite: AnimationSprite, useAllSprite: boolean = true) {
		// console.log("Render sprite", this.sprite.name.name, "to image");
		const spriteMeasure = useAllSprite
			? Measurer.measureSprite(sprite, this.scale)
			: Measurer.measureFrame(sprite, this.scale, 0);
		return this.renderFrameAsImage(
			sprite,
			spriteMeasure.inflate(FRAME_PADDING, FRAME_PADDING),
			0
		);
	}

	async generateVideoFromBuffers(sprite: Sprite, images: Buffer[], framerate: number) {
		const tmpDir = dirSync({ unsafeCleanup: true });
		const outputPath = join(tmpDir.name, `${sprite.name.name}.webm`);

		try {
			// Write each buffer to a numbered file in tmpDir
			const fileNames: string[] = [];
			for (let i = 0; i < images.length; i++) {
				const fileName = join(tmpDir.name, `img_${`${i}`.padStart(4, '0')}.png`);
				await writeFile(fileName, images[i]!);
				fileNames.push(fileName);
			}

			await new Promise<void>((resolve, reject) => {
				ffmpeg()
					// Input files sequence pattern
					.input(join(tmpDir.name, `img_%04d.png`))
					.inputOptions([`-framerate ${framerate}`, '-vcodec', 'png'])
					.outputOptions([
						// * webm
						'-c:v',
						'libvpx-vp9',
						'-pix_fmt',
						'yuva420p', // pixel format with alpha
						// "-auto-alt-ref", // necessary with libvpx
						// "0",
						'-crf',
						'25',
						'-threads',
						'8',
						'-cpu-used',
						'0',
						'-row-mt',
						'1',
						'-preset',
						'veryslow',
						'-movflags',
						'+faststart'
					])
					.on('start', (commandLine) => {
						// console.log(commandLine);
					})
					.on('error', (err, stdout, stderr) => {
						console.error('Error occurred:', err.message);
						console.error('ffmpeg stdout:', stdout);
						console.error('ffmpeg stderr:', stderr);
						reject(err);
					})
					.on('end', () => {
						resolve();
					})
					.save(outputPath);
			});

			const video = await readFile(outputPath);
			tmpDir.removeCallback();
			return video;
		} finally {
			// Clean up temporary files
			tmpDir.removeCallback();
		}
		return null;
	}

	async renderVideo(sprite: AnimationSprite) {
		// console.log("Render sprite", this.sprite.name.name, "to video");
		const spriteMeasure = Measurer.measureSprite(sprite, this.scale).inflate(
			FRAME_PADDING,
			FRAME_PADDING
		);
		const frameCount = countFrames(sprite.sprite);
		const frames: Buffer[] = [];
		for (let frame = 0; frame < frameCount; frame++) {
			frames.push(this.renderFrameAsImage(sprite, spriteMeasure, frame));
		}
		return await this.generateVideoFromBuffers(
			sprite.sprite,
			frames,
			this.animation.frame_rate
		);
	}
}
