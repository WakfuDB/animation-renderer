import { BinaryReader as SimpleBinaryReader } from '@glagan/binary-reader';

type BaseNumberReadType = 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32';
type BaseFloatReadType = 'f32' | 'f64';
type BaseReadType = BaseNumberReadType | BaseFloatReadType | 'string';
type ReadType =
	| BaseReadType
	| { key: BaseReadType; value: ReadType }
	| ((reader: BinaryReader) => any)
	| [BaseNumberReadType, BaseReadType]
	| [BaseNumberReadType, { key: BaseReadType; value: ReadType }]
	| [BaseNumberReadType, (reader: BinaryReader) => any];

type ReadResult<T> = T extends 'string'
	? string
	: T extends BaseNumberReadType | BaseFloatReadType
		? number
		: T extends [BaseNumberReadType, infer U]
			? ReadResult<U>[]
			: T extends { key: infer K; value: infer V }
				? K extends BaseReadType // this is the key fix!
					? Record<ReadResult<K>, ReadResult<V>>
					: never
				: T extends (reader: BinaryReader) => infer R
					? R
					: never;

export class BinaryReader {
	reader: SimpleBinaryReader;

	constructor(buffer: Buffer) {
		this.reader = new SimpleBinaryReader(buffer);
	}

	readString() {
		const result = [];
		let char = this.reader.readUint8();
		while (char !== 0) {
			result.push(char);
			char = this.reader.readUint8();
		}
		return String.fromCharCode(...result);
	}

	readMap<K extends BaseReadType, V extends ReadType>(
		keyType: K,
		valueType: V,
		sizeType: BaseNumberReadType = 'u32'
	): Record<ReadResult<K>, ReadResult<V>> {
		const size = this.read(sizeType);
		const map: Record<string | number | symbol, any> = {};
		for (let index = 0; index < size; index++) {
			const keyValue = this.read(keyType);
			const value = this.read(valueType);
			map[keyValue as string | number | symbol] = value;
		}
		return map as Record<ReadResult<K>, ReadResult<V>>;
	}

	readArray(sizeType: BaseNumberReadType, valueType: ReadType) {
		const size = this.read(sizeType);
		const array: any[] = [];
		for (let index = 0; index < size; index++) {
			array.push(this.read(valueType));
		}
		return array;
	}

	read<T extends ReadType>(type: T): ReadResult<T> {
		if (Array.isArray(type)) {
			return this.readArray(type[0], type[1]) as ReadResult<T>;
		} else if (typeof type === 'object') {
			return this.readMap(type.key, type.value) as ReadResult<T>;
		} else if (typeof type === 'function') {
			return type(this);
		} else if (type === 'u8') {
			return this.reader.readUint8() as ReadResult<T>;
		} else if (type === 'u16') {
			return this.reader.readUint16() as ReadResult<T>;
		} else if (type === 'u32') {
			return this.reader.readUint32() as ReadResult<T>;
		} else if (type === 'i8') {
			return this.reader.readInt8() as ReadResult<T>;
		} else if (type === 'i16') {
			return this.reader.readInt16() as ReadResult<T>;
		} else if (type === 'i32') {
			return this.reader.readInt32() as ReadResult<T>;
		} else if (type === 'f32') {
			return this.reader.readFloat32() as ReadResult<T>;
		} else if (type === 'f64') {
			return this.reader.readFloat64() as ReadResult<T>;
		}
		// else if (type === "string") {
		return this.readString() as ReadResult<T>;
	}

	readIf<T extends ReadType>(condition: boolean, type: T): ReadResult<T> | null {
		if (condition) {
			return this.read(type);
		}
		return null;
	}
}
