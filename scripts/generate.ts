import { writeFile } from 'fs/promises';
import { AnimationRenderer } from '../src/render.ts';
import { parseArgs } from 'util';
import { mkdir } from 'fs/promises';

export async function main() {
	const { values: args } = parseArgs({
		options: {
			id: {
				type: 'string'
			}
		}
	});
	if (!args.id) {
		console.error('No id provided');
		return;
	}
	await mkdir('output');

	const animation = await AnimationRenderer.fromFile('npcs', args.id);
	// await writeFile(`${animationId}.json`, JSON.stringify(animation.animation, undefined, 4));
	if (animation.hasTexture) {
		const staticSprite = animation.findStaticSprite();
		if (!staticSprite) {
			console.warn(`No static sprite found in:`, animation.availableSprites.join(', '));
			return null;
		}
		const image = animation.renderImage(staticSprite);
		if (image) {
			await writeFile(`./output/${args.id}.png`, image);
			console.log(`Wrote image to ./output/${args.id}.png`);
		}
		const video = await animation.renderVideo(staticSprite);
		if (video) {
			await writeFile(`./output/${args.id}.webm`, video);
			console.log(`Wrote video to ./output/${args.id}.webm`);
		}
	} else {
		console.warn(`No texture found in`, animation);
	}
}

await main();
