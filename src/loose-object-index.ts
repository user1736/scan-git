import { promises as fsPromises } from 'fs';
import { inflateSync } from './fast-inflate.js';
import { GitObject, InternalGitObjectContent, InternalGitObjectHeader } from './types.js';
import { binarySearchHash } from './utils.js';

type LooseObjectMap = Map<string, string>;

async function createLooseObjectMap(gitdir: string): Promise<LooseObjectMap> {
    const looseObjectMap: LooseObjectMap = new Map();
    const objectsPath = `${gitdir}/objects`;
    const looseDirs = (await fsPromises.readdir(objectsPath)).filter((p) =>
        /^[0-9a-f]{2}$/.test(p)
    );

    const objectDirs = await Promise.all(
        looseDirs.map((p) =>
            fsPromises
                .readdir(`${objectsPath}/${p}`)
                .then((files) => files.map((f) => [p + f, `${objectsPath}/${p}/${f}`]))
        )
    );

    for (const dir of objectDirs) {
        for (const [oid, filepath] of dir) {
            looseObjectMap.set(oid, filepath);
        }
    }

    return looseObjectMap;
}

function createGetOidFromHash(looseObjectMap: Map<string, string>) {
    const hashes = Buffer.alloc(20 * looseObjectMap.size);
    const oidByHash = new Array<string>(looseObjectMap.size);
    const fanoutTable = new Array<[start: number, end: number]>(256);

    [...looseObjectMap.keys()]
        .sort((a, b) => (a < b ? -1 : 1))
        .forEach((oid, idx) => {
            hashes.write(oid, idx * 20, 'hex');
            oidByHash[idx] = oid;
        });

    for (let i = 0, j = 0, prevOffset = 0; i < 256; i++) {
        let offset = prevOffset;

        while (j < hashes.length && hashes[j * 20] === i) {
            offset++;
            j++;
        }

        fanoutTable[i] = [prevOffset, offset];
        prevOffset = offset;
    }

    return function getOidFromHash(hash: Buffer) {
        const [start, end] = fanoutTable[hash[0]];
        const idx = start !== end ? binarySearchHash(hashes, hash, start, end - 1) : -1;

        if (idx !== -1) {
            return oidByHash[idx];
        }

        return null;
    };
}

function parseLooseGitObjectHeader(buffer: Buffer): InternalGitObjectHeader {
    const spaceIndex = buffer.indexOf(32); // first space
    const nullIndex = buffer.indexOf(0, spaceIndex + 1); // first null is the end of header
    const type = buffer.toString('utf8', 0, spaceIndex) as GitObject['type'];
    const length = parseInt(buffer.toString('utf8', spaceIndex + 1, nullIndex), 10);

    return {
        type,
        length
    };
}

function parseLooseGitObject(buffer: Buffer): InternalGitObjectContent {
    const spaceIndex = buffer.indexOf(32); // first space
    const nullIndex = buffer.indexOf(0, spaceIndex + 1); // first null value
    const type = buffer.toString('utf8', 0, spaceIndex) as GitObject['type']; // get type of object

    return {
        type,
        object: buffer.slice(nullIndex + 1)
    };
}

export async function createLooseObjectIndex(gitdir: string) {
    const looseObjectMap = await createLooseObjectMap(gitdir);
    const getOidFromHash = createGetOidFromHash(looseObjectMap);
    const readObjectHeaderByOid = async (oid: string) => {
        const filepath = looseObjectMap.get(oid);

        if (filepath !== undefined) {
            let fh: fsPromises.FileHandle | null = null;
            try {
                fh = await fsPromises.open(filepath);

                const headerBuffer = Buffer.alloc(64);
                await fh.read(headerBuffer, 0, 64, 0);

                return parseLooseGitObjectHeader(inflateSync(headerBuffer));
            } finally {
                fh?.close();
            }
        }

        return null;
    };
    const readObjectByOid = async (oid: string) => {
        const filepath = looseObjectMap.get(oid);

        if (filepath !== undefined) {
            const deflated = await fsPromises.readFile(filepath);

            return parseLooseGitObject(inflateSync(deflated));
        }

        return null;
    };

    return {
        readObjectHeaderByOid,
        readObjectHeaderByHash(hash: Buffer) {
            const oid = getOidFromHash(hash);

            return oid !== null ? readObjectHeaderByOid(oid) : null;
        },
        readObjectByOid,
        readObjectByHash(hash: Buffer) {
            const oid = getOidFromHash(hash);

            return oid !== null ? readObjectByOid(oid) : null;
        }
    };
}
