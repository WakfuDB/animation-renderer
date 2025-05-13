import { BinaryReader } from './reader.ts';
import type { Animation } from './types.ts';

export function readAnimation(buffer: Buffer): Animation {
	const reader = new BinaryReader(buffer);
	const version = reader.read('u8');
	reader.read('i16'); // Unused ?
	const animationFlags = {
		useAtlas: (version & 0x1) == 0x1,
		useLocalIndex: (version & 0x2) == 0x2,
		usePerfectHitTest: (version & 0x4) == 0x4,
		isOptimized: (version & 0x8) == 0x8,
		useTransformIndex: (version & 0x10) == 0x10
	};
	let texture_count = 0;
	return {
		version,
		frame_rate: reader.read('u8'),
		index: reader.readIf(animationFlags.useLocalIndex, (reader) => {
			const flagsValue = reader.read('u8');
			const flags = {
				hasScale: (flagsValue & 0x1) == 0x1,
				hasExtension: (flagsValue & 0x2) == 0x2,
				hasHidingPart: (flagsValue & 0x4) == 0x4,
				hasRenderRadius: (flagsValue & 0x8) == 0x8,
				useFlip: (flagsValue & 0x10) == 0x10,
				usePerfectHitTest: (flagsValue & 0x20) == 0x20,
				canHidePart: (flagsValue & 0x40) == 0x40,
				isExtended: (flagsValue & 0x80) == 0x80
			};
			return {
				flags: flagsValue,
				decodedFlags: flags,
				scale: reader.readIf(flags.hasScale, 'f32'),
				render_radius: reader.readIf(flags.hasRenderRadius, 'f32'),
				file_names: reader.readIf(flags.hasExtension, ['u16', 'string']),
				parts_hidden_by: reader.readIf(flags.hasHidingPart, [
					'u8',
					(reader) => ({
						crc_key: reader.read('i32'),
						crc_to_hide: reader.read('i32')
					})
				]),
				parts_to_be_hidden: reader.readIf(flags.canHidePart, [
					'u8',
					(reader) => ({
						item_name: reader.read('string'),
						crc_key: reader.read('i32')
					})
				]),
				extension: reader.readIf(flags.isExtended, (reader) => {
					const flags = reader.read('i32');
					const heights =
						reader.readIf((flags & 0x1) == 0x1, {
							key: 'i32',
							value: 'i8'
						}) ?? null;
					// Add +1 to heights values
					if (heights) {
						for (const key in heights) {
							heights[key] = heights[key]! + 1;
						}
					}
					return {
						heights,
						highlight_color: reader.readIf((flags & 0x2) == 0x2, (reader) => ({
							red: reader.read('f32'),
							green: reader.read('f32'),
							blue: reader.read('f32'),
							alpha: 1
						}))
					};
				}),
				animation_files: reader.read([
					'u16',
					(reader) => ({
						name: reader.read('string'),
						crc: reader.read('i32'),
						file_index: reader.read('i16')
					})
				])
			};
		}),
		texture_count: (texture_count = reader.read('u16')),
		texture:
			texture_count === 1
				? {
						name: reader.read('string'),
						crc: reader.read('i32')
					}
				: null,
		shapes: reader.read([
			'u16',
			(reader) => ({
				id: reader.read('i16'),
				texture_index: reader.read('i16'),
				top: reader.read('u16') / 65535,
				left: reader.read('u16') / 65535,
				bottom: reader.read('u16') / 65535,
				right: reader.read('u16') / 65535,
				width: reader.read('u16'),
				height: reader.read('u16'),
				offset_x: reader.read('f32'),
				offset_y: reader.read('f32')
			})
		]),
		transform: reader.readIf(animationFlags.useTransformIndex, (reader) => ({
			colors: reader.read(['u32', 'f32']),
			rotations: reader.read(['u32', 'f32']),
			translations: reader.read(['u32', 'f32']),
			actions: reader.read([
				'u32',
				(reader) => {
					const id = reader.read('u8');
					const params = reader.read('u8');
					if (id === 1) {
						return {
							kind: 'GoTo' as const,
							name: reader.read('string'),
							percent: reader.readIf(params === 2, 'u8')
						};
					} else if (id === 2) {
						return { kind: 'GoToStatic' as const };
					} else if (id === 3) {
						return { kind: 'RunScript' as const, name: reader.read('string') };
					} else if (id === 4) {
						const first = reader.read('string');
						if (first === '#optimized') {
							const count = (params - 1) / 2;
							const names = [];
							for (let index = 0; index < count; index++) {
								names.push(reader.read('string'));
							}
							const percents = [];
							for (let index = 0; index < count; index++) {
								percents.push(reader.read('u8'));
							}
							return { kind: 'GoToRandom' as const, names, percents };
						}
						const count = params - 1;
						const names = [];
						for (let index = 0; index < count; index++) {
							names.push(reader.read('string'));
						}
						return { kind: 'GoToRandom' as const, names };
					} else if (id === 5) {
						return { kind: 'Hit' as const };
					} else if (id === 6) {
						return { kind: 'Delete' as const };
					} else if (id === 7) {
						return { kind: 'End' as const };
					} else if (id === 8) {
						const count = (params - 1) / 2;
						const previous = [];
						const next = [];
						for (let index = 0; index < count; index++) {
							previous.push(reader.read('string'));
							next.push(reader.read('string'));
						}
						return {
							kind: 'GoToIfPrevious' as const,
							previous,
							next,
							default: reader.readIf(params % 2 === 1, 'string')
						};
					} else if (id === 9) {
						const particleId = reader.read('i32');
						const offsetX = reader.readIf(params > 1, 'i16');
						const offsetY = reader.readIf(params > 2, 'i16');
						const offsetZ = reader.readIf(params > 3, 'i16');
						return {
							kind: 'AddParticle' as const,
							particleId,
							offsetX,
							offsetY,
							offsetZ
						};
					}
					// else if (id === 10) {
					return { kind: 'SetRadius' as const, radius: reader.read('i8') };
					// }
				}
			])
		})),
		sprites: reader.read([
			'u16',
			(reader) => {
				const tag = reader.read('i8');
				const id = reader.read('i16');
				const flagsValue = reader.read('u8');
				const flags = {
					hasName: (flagsValue & 0x40) == 0x40
				};
				const name = {
					name: reader.readIf(flags.hasName, 'string'),
					nameCrc: reader.read('i32'),
					baseNameCrc: reader.read('i32')
				};
				const payload = (() => {
					if (tag === 1) {
						return {
							kind: 'Single' as const,
							spriteId: reader.read('i16'),
							actionInfo: reader.read(['u16', 'i16'])
						};
					} else if (tag === 2) {
						return {
							kind: 'SingleNoAction' as const,
							spriteId: reader.read('i16')
						};
					} else if (tag === 3) {
						return {
							kind: 'SingleFrame' as const,
							spriteIds: reader.read(['u16', 'i16']),
							actionInfo: reader.read(['u16', 'i16'])
						};
					} else if (tag === 4) {
						return {
							kind: 'Frames' as const,
							framePos: reader.read(['u16', 'i32']),
							spriteInfo: reader.read(['u16', 'i16']),
							actionInfo: reader.read(['u16', 'i16'])
						};
					}
				})()!;
				const frameData = (() => {
					const tag = reader.read('u8');
					if (tag === 1) {
						return {
							kind: 'Bytes' as const,
							buffer: reader.read(['u32', 'u8'])
						};
					} else if (tag === 2) {
						return {
							kind: 'Shorts' as const,
							buffer: reader.read(['u32', 'u16'])
						};
					}
					// else if (tag === 4) {
					return {
						kind: 'Ints' as const,
						buffer: reader.read(['u32', 'u32'])
					};
					// }
				})();
				return {
					id,
					name,
					flags: flagsValue,
					decodedFlags: flags,
					frameData,
					payload
				};
			}
		]),
		imports: reader.read([
			'u16',
			(reader) => ({
				id: reader.read('i16'),
				name: reader.read('string'),
				file_index: reader.read('i32')
			})
		])
	};
}
