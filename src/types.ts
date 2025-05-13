export type FrameData =
	| {
			kind: 'Bytes';
			buffer: number[];
	  }
	| {
			kind: 'Shorts';
			buffer: number[];
	  }
	| {
			kind: 'Ints';
			buffer: number[];
	  };

export type Sprite = {
	id: number;
	name: {
		name: string | null;
		nameCrc: number;
		baseNameCrc: number;
	};
	flags: number;
	decodedFlags: {
		hasName: boolean;
	};
	frameData: FrameData;
	payload:
		| {
				kind: 'Single';
				spriteId: number;
				actionInfo: number[];
				spriteIds?: undefined;
				framePos?: undefined;
				spriteInfo?: undefined;
		  }
		| {
				kind: 'SingleNoAction';
				spriteId: number;
				actionInfo?: undefined;
				spriteIds?: undefined;
				framePos?: undefined;
				spriteInfo?: undefined;
		  }
		| {
				kind: 'SingleFrame';
				spriteIds: number[];
				actionInfo: number[];
				framePos?: undefined;
				spriteInfo?: undefined;
		  }
		| {
				kind: 'Frames';
				framePos: number[];
				spriteInfo: number[];
				actionInfo: number[];
				spriteIds?: undefined;
		  };
};

export type Shape = {
	id: number;
	texture_index: number;
	top: number;
	left: number;
	bottom: number;
	right: number;
	width: number;
	height: number;
	offset_x: number;
	offset_y: number;
};

export type Action =
	| {
			kind: 'GoTo';
			name: string;
			percent?: number | null;
	  }
	| { kind: 'GoToStatic' }
	| { kind: 'RunScript'; name: string }
	| { kind: 'GoToRandom'; names: string[]; percents?: number[] | null }
	| { kind: 'Hit' }
	| { kind: 'Delete' }
	| { kind: 'End' }
	| {
			kind: 'GoToIfPrevious';
			previous: string[];
			next: string[];
			default?: string | null;
	  }
	| {
			kind: 'AddParticle';
			particleId: number;
			offsetX?: number | null;
			offsetY?: number | null;
			offsetZ?: number | null;
	  }
	| { kind: 'SetRadius'; radius: number };

export type Animation = {
	version: number;
	frame_rate: number;
	index?: {
		flags: number;
		decodedFlags: {
			hasScale: boolean;
			hasExtension: boolean;
			hasHidingPart: boolean;
			hasRenderRadius: boolean;
			useFlip: boolean;
			usePerfectHitTest: boolean;
			canHidePart: boolean;
			isExtended: boolean;
		};
		scale: number | null;
		render_radius: number | null;
		file_names: string[] | null;
		parts_hidden_by:
			| {
					crc_key: number;
					crc_to_hide: number;
			  }[]
			| null;
		parts_to_be_hidden:
			| {
					item_name: string;
					crc_key: number;
			  }[]
			| null;
		extension: {
			heights: Record<number, number> | null;
			highlight_color: {
				red: number;
				green: number;
				blue: number;
				alpha: number;
			} | null;
		} | null;
		animation_files: {
			name: string;
			crc: number;
			file_index: number;
		}[];
	} | null;
	texture_count: number;
	texture: {
		name: string;
		crc: number;
	} | null;
	shapes: Shape[];
	transform?: {
		colors: number[];
		rotations: number[];
		translations: number[];
		actions: Action[];
	} | null;
	sprites: Sprite[];
	imports: {
		id: number;
		name: string;
		file_index: number;
	}[];
};

export type AnimationType =
	| 'npcs'
	| 'dynamics'
	| 'equipments'
	| 'gui'
	| 'interactives'
	| 'pets'
	| 'players'
	| 'resources';
