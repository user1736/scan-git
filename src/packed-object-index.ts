import { join as pathJoin } from 'path';
import { promises as fsPromises, statSync } from 'fs';
import { inflateSync } from './fast-inflate.js';
import { binarySearchHash, BufferCursor } from './utils.js';
import {
    InternalReadObject,
    InternalGitObjectContent,
    InternalReadObjectHeader,
    InternalGitObjectHeader
} from './types.js';

type Type = 'commit' | 'tree' | 'blob' | 'tag';
type PackedType =
    | typeof INVALID
    | typeof COMMIT
    | typeof TREE
    | typeof BLOB
    | typeof RESERVED
    | typeof TAG
    | typeof OSF_DELTA
    | typeof REF_DELTA;

const FPB_LENGTH_BITS = 0b00001111;
const FPB_MULTIBYTE_LENGTH_BIT = 0b10000000;
const FPB_TYPE_BITS = 0b01110000;

const INVALID = 0b0000000;
const COMMIT = 0b0010000;
const TREE = 0b0100000;
const BLOB = 0b0110000;
const RESERVED = 0b1010000;
const TAG = 0b1000000;
const OSF_DELTA = 0b1100000;
const REF_DELTA = 0b1110000;
const types = {
    0b0000000: 'invalid',
    0b0010000: 'commit',
    0b0100000: 'tree',
    0b0110000: 'blob',
    0b1010000: 'reserved',
    0b1000000: 'tag',
    0b1100000: 'ofs_delta',
    0b1110000: 'ref_delta'
} as const;

const OP_COPY = 0b10000000;
const OP_SIZE = 0b01110000;
const OP_OFFS = 0b00001111;

function decodeVarInt(reader: BufferCursor) {
    let byte = 0;
    let result = -1;

    do {
        byte = reader.readUInt8();
        result = ((result + 1) << 7) | (byte & 0b01111111);
    } while (byte & 0b10000000);

    return result;
}

function readVarIntLE(reader: BufferCursor) {
    let result = 0;
    let shift = 0;
    let byte = 0;

    do {
        byte = reader.readUInt8();
        result |= (byte & 0b01111111) << shift;
        shift += 7;
    } while (byte & 0b10000000);

    return result;
}

function readCompactLE(reader: BufferCursor, flags: number, size: number) {
    let result = 0;
    let shift = 0;

    for (let i = 0; i < size; i++) {
        if (flags & 1) {
            result |= reader.readUInt8() << shift;
        }

        flags >>= 1;
        shift += 8;
    }

    return result;
}

function readOp(patchReader: BufferCursor, source: Buffer) {
    const byte = patchReader.readUInt8();

    if (byte & OP_COPY) {
        // copy consists of 4 byte offset, 3 byte size (in LE order)
        const offset = readCompactLE(patchReader, byte & OP_OFFS, 4);
        let size = readCompactLE(patchReader, (byte & OP_SIZE) >> 4, 3);

        // Yup. They really did this optimization.
        if (size === 0) {
            size = 0x10000;
        }

        return source.slice(offset, offset + size);
    }

    // insert
    return patchReader.slice(byte);
}

function applyDelta(delta: Buffer, source: Buffer): Buffer {
    const patchReader = new BufferCursor(delta);
    const sourceSize = readVarIntLE(patchReader);

    if (sourceSize !== source.byteLength) {
        throw new Error(
            `applyDelta expected source buffer to be ${sourceSize} bytes but the provided buffer was ${source.length} bytes`
        );
    }

    const targetSize = readVarIntLE(patchReader);
    const firstOp = readOp(patchReader, source);

    // Speed optimization - return raw buffer if it's just single simple copy
    if (firstOp.byteLength === targetSize) {
        return firstOp;
    }

    // Otherwise, allocate a fresh buffer and slices
    const target = Buffer.allocUnsafe(targetSize);
    const writer = new BufferCursor(target);

    writer.copy(firstOp);

    while (!patchReader.eof()) {
        writer.copy(readOp(patchReader, source));
    }

    if (targetSize !== writer.offset) {
        throw new Error(
            `applyDelta expected target buffer to be ${targetSize} bytes but the resulting buffer was ${writer.offset} bytes`
        );
    }

    return target;
}

const buffers = new Array(5000);
let reuseBufferCount = 0;

class GitPackIndex {
    cache: Map<number, InternalGitObjectContent>;

    constructor(
        public filename: string,
        private fh: fsPromises.FileHandle,
        public readObjectFromAllSources: InternalReadObject,
        public readObjectHeaderFromAllSources: InternalReadObjectHeader,
        public getOffset: (hash: Buffer) => number | undefined
    ) {
        this.cache = new Map();
    }

    readObjectHeader(hash: Buffer) {
        const offset = this.getOffset(hash);

        if (offset !== undefined) {
            return this.readObjectFromFile(offset);
        }

        return this.readObjectFromAllSources(hash);
    }

    readObject(hash: Buffer) {
        const offset = this.getOffset(hash);

        if (offset !== undefined) {
            return this.readObjectFromFile(offset);
        }

        return this.readObjectFromAllSources(hash);
    }

    private read(buffer: Buffer, start: number) {
        return this.fh.read(buffer, 0, buffer.byteLength, start);
    }

    private async readObjectPreludeFromFile(start: number) {
        const header =
            reuseBufferCount > 0 ? buffers[--reuseBufferCount] : Buffer.allocUnsafe(4096);

        await this.read(header, start);

        const reader = new BufferCursor(header);
        const firstByte = reader.readUInt8();
        const btype = (firstByte & FPB_TYPE_BITS) as PackedType;

        if (btype === INVALID || btype === RESERVED) {
            throw new Error(`Unrecognized type: 0b${btype.toString(2)}`);
        }

        // The length encoding get complicated.
        // Last four bits of length is encoded in bits 3210
        // Whether the next byte is part of the variable-length encoded number
        // is encoded in bit 7
        let length = firstByte & FPB_LENGTH_BITS;
        if (firstByte & FPB_MULTIBYTE_LENGTH_BIT) {
            length |= readVarIntLE(reader) << 4;
        }

        let deltaRef: Buffer | number | null = null;

        // Handle deltified objects
        if (btype === OSF_DELTA) {
            deltaRef = start - decodeVarInt(reader);
        } else if (btype === REF_DELTA) {
            const hash = reader.slice(20);
            const offset = this.getOffset(hash);

            deltaRef = typeof offset === 'number' ? offset : Buffer.from(hash);
        }

        return {
            btype,
            length,
            reader,
            deltaRef
        };
    }

    async readObjectHeaderFromFile(start: number) {
        const { btype, length, reader, deltaRef } = await this.readObjectPreludeFromFile(start);
        let type: Type;

        buffers[reuseBufferCount++] = reader.buffer;

        if (deltaRef !== null) {
            const delta =
                typeof deltaRef === 'number'
                    ? await this.readObjectHeaderFromFile(deltaRef)
                    : await this.readObjectHeaderFromAllSources(deltaRef);

            if (delta === null) {
                throw new Error('Could not read delta object from packfile');
            }

            type = delta.type;
        } else {
            type = types[btype] as Type;
        }

        const result: InternalGitObjectHeader = {
            type,
            length
        };

        return result;
    }

    async readObjectFromFile(start: number) {
        const cachedResult = this.cache.get(start);
        if (cachedResult !== undefined) {
            return cachedResult;
        }

        const { btype, length, reader, deltaRef } = await this.readObjectPreludeFromFile(start);
        const header = reader.buffer;
        let type: Type;

        // Handle undeltified objects
        const objSize = length + 16;
        const objOffset = start + reader.offset;
        const bufferLeft = header.byteLength - reader.offset;
        const buffer =
            bufferLeft >= objSize
                ? header.slice(reader.offset)
                : (await this.read(Buffer.allocUnsafe(objSize), objOffset)).buffer;

        let object = inflateSync(buffer);
        buffers[reuseBufferCount++] = header;

        // Assert that the object lexngth is as expected.
        if (object.byteLength !== length) {
            throw new Error(
                `Packfile told us object would have length ${length} but it had length ${object.byteLength}`
            );
        }

        if (deltaRef !== null) {
            const delta =
                typeof deltaRef === 'number'
                    ? await this.readObjectFromFile(deltaRef)
                    : await this.readObjectFromAllSources(deltaRef);

            if (delta === null) {
                throw new Error('Could not read delta object from packfile');
            }

            type = delta.type;
            object = applyDelta(object, delta.object);
        } else {
            type = types[btype] as Type;
        }

        // result.source = `objects/pack/${packIndex.packFilename}`;
        const result: InternalGitObjectContent = {
            type,
            object
        };

        this.cache.set(start, result);

        return result;
    }
}

async function loadPackIndex(
    filename: string,
    readObjectFromAllSources: InternalReadObject,
    readObjectHeaderFromAllSources: InternalReadObjectHeader
) {
    if ((await fsPromises.stat(filename)).size > 2048 * 1024 * 1024) {
        throw new Error('Packfiles > 2GB is not supported for now');
    }

    let fh: fsPromises.FileHandle | null = null;
    try {
        fh = await fsPromises.open(filename);

        const header = Buffer.allocUnsafe(4 * (2 + 255 + 1));
        const headerSize = header.byteLength;

        await fh.read(header, 0, headerSize);

        // Check for IDX v2 magic number
        if (header.readUInt32BE(0) !== 0xff744f63) {
            throw new Error(`Bad magick 0x${header.toString('hex', 0, 4)} in ${filename}`);
        }

        // version
        const version = header.readUInt32BE(4);
        if (version !== 2) {
            throw new Error(
                `Bad packfile version "${version}" in ${filename}. (Only version 2 is supported)`
            );
        }

        // Get entries count
        const size = header.readUInt32BE(4 * (2 + 255));

        // read hashes & offsets
        const hashes = Buffer.allocUnsafe(20 * size);
        const offsets = Buffer.allocUnsafe(4 * size);

        await fh.read(hashes, 0, hashes.byteLength, headerSize);
        await fh.read(offsets, 0, offsets.byteLength, headerSize + (20 + 4) * size);

        // build fanout table
        const fanoutTable = new Array(256);
        for (let i = 0, prevOffset = 0; i < 256; i++) {
            const offset = header.readUInt32BE(8 + i * 4);

            fanoutTable[i] = [prevOffset, offset];
            prevOffset = offset;
        }

        // api
        const getIdx = (hash: Buffer) => {
            const [start, end] = fanoutTable[hash[0]];
            const idx = start !== end ? binarySearchHash(hashes, hash, start, end - 1) : -1;

            return idx;
        };

        const packFilename = filename.replace(/\.idx$/, '.pack');
        return new GitPackIndex(
            packFilename,
            await fsPromises.open(packFilename),
            readObjectFromAllSources,
            readObjectHeaderFromAllSources,
            (hash: Buffer) => {
                const idx = getIdx(hash);

                return idx !== -1 ? offsets.readUInt32BE(idx * 4) : undefined;
            }
        );
    } finally {
        fh?.close();
    }
}

export async function createPackedObjectIndex(
    gitdir: string,
    readObjectFromAllSources: InternalReadObject,
    readObjectHeaderFromAllSources: InternalReadObjectHeader
) {
    const packdir = pathJoin(gitdir, 'objects/pack');
    const filelist = (await fsPromises.readdir(packdir))
        .filter((filename) => filename.endsWith('.idx'))
        .map((filename) => `${packdir}/${filename}`);

    // sort files in order from youngest to older
    const mtime = filelist.reduce(
        (map, filename) => map.set(filename, statSync(filename).mtime),
        new Map()
    );

    const packIndecies = await Promise.all(
        filelist
            .sort((a, b) => mtime.get(b) - mtime.get(a))
            .map((filename) =>
                loadPackIndex(filename, readObjectFromAllSources, readObjectHeaderFromAllSources)
            )
    );

    // process.on("exit", () => {
    //   packIndecies.forEach(pi =>
    //     console.log(
    //       pi.used || "----",
    //       path.basename(pi.filename),
    //       pi.offsets.size
    //     )
    //   );
    // });

    const readObjectHeaderByHash = (hash: Buffer) => {
        for (const packedObjectIndex of packIndecies) {
            const offset = packedObjectIndex.getOffset(hash);

            if (offset !== undefined) {
                return packedObjectIndex.readObjectHeaderFromFile(offset);
            }
        }

        return null;
    };

    const readObjectByHash = (hash: Buffer) => {
        for (const packedObjectIndex of packIndecies) {
            const offset = packedObjectIndex.getOffset(hash);

            if (offset !== undefined) {
                return packedObjectIndex.readObjectFromFile(offset);
            }
        }

        return null;
    };

    return {
        readObjectHeaderByHash,
        readObjectByHash,
        readObjectHeaderByOid(oid: string) {
            return readObjectHeaderByHash(Buffer.from(oid, 'hex'));
        },
        readObjectByOid(oid: string) {
            return readObjectByHash(Buffer.from(oid, 'hex'));
        }
    };
}
