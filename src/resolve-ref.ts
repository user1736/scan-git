import { promises as fsPromises } from 'fs';
import { scanFs } from '@discoveryjs/scan-fs';
import { isOid } from './utils.js';

// @see https://git-scm.com/docs/git-rev-parse.html#_specifying_revisions
const refpaths = (ref: string) => [
    `${ref}`,
    `refs/${ref}`,
    `refs/tags/${ref}`,
    `refs/heads/${ref}`,
    `refs/remotes/${ref}`,
    `refs/remotes/${ref}/HEAD`
];

export async function createRefIndex(gitdir: string) {
    const packedRefs = await readPackedRefs(gitdir);
    // expand a ref into a full form
    const expandRef = async (ref: string) => {
        // Is it a complete and valid SHA?
        if (isOid(ref)) {
            return ref;
        }

        // Look in all the proper paths, in this order
        const allpaths = refpaths(ref);

        for (const ref of allpaths) {
            if (packedRefs.has(ref)) {
                return ref;
            }

            try {
                await fsPromises.stat(`${gitdir}/${ref}`);
                return ref;
            } catch {}
        }

        // Do we give up?
        throw new Error(`Ref "${ref}" not found`);
    };
    const resolveRef = async (ref: string): Promise<string> => {
        // Is it a ref pointer?
        if (ref.startsWith('ref: ')) {
            ref = ref.slice(5); // 'ref: '.length == 5
        }

        // Is it a complete and valid SHA?
        if (isOid(ref)) {
            return ref;
        }

        const expandedRef = await expandRef(ref);
        ref = (await fsPromises.readFile(`${gitdir}/${expandedRef}`, 'utf8')).trimEnd();

        return resolveRef(ref);
    };

    return {
        expandRef,
        resolveRef,
        async isRefExists(ref: string) {
            try {
                await expandRef(ref);
                return true;
            } catch (err) {
                return false;
            }
        },

        listBranches(remote?: string) {
            if (remote) {
                return listRefs(gitdir, `refs/remotes/${remote}/`);
            } else {
                return listRefs(gitdir, 'refs/heads/');
            }
        },

        listTags() {
            return listRefs(gitdir, 'refs/tags/');
        }
    };
}

// https://stackoverflow.com/a/40355107/2168416
function compareRefNames(a: string, b: string) {
    const _a = a.replace(/\^\{\}$/, '');
    const _b = b.replace(/\^\{\}$/, '');
    const tmp = -(_a < _b) || Number(_a > _b);

    if (tmp === 0) {
        return a.endsWith('^{}') ? 1 : -1;
    }

    return tmp;
}

// List all the refs that match the `filepath` prefix
async function listRefs(gitdir: string, prefix: string) {
    const packedRefs = await readPackedRefs(gitdir);
    const files = new Set<string>();

    try {
        for (const file of await scanFs({ basedir: `${gitdir}/${prefix}` })) {
            files.add(file.path);
        }
    } catch (e) {}

    // add refs filtered by a prefix as prefix
    for (const ref of packedRefs.keys()) {
        if (ref.startsWith(prefix) && !ref.endsWith('^{}')) {
            files.add(ref.slice(prefix.length));
        }
    }

    // since we just appended things onto an array, we need to sort them now
    return [...files].sort(compareRefNames);
}

async function readPackedRefs(gitdir: string) {
    const text = await fsPromises.readFile(`${gitdir}/packed-refs`, 'utf8');
    const refs = new Map<string, string>();
    let ref = null;

    for (const line of text.trim().split('\n')) {
        if (line.startsWith('#')) {
            continue;
        }

        if (line.startsWith('^')) {
            // This is a oid for the commit associated with the annotated tag immediately preceding this line.
            // Trim off the '^'
            const oid = line.slice(1);
            // The tagname^{} syntax is based on the output of `git show-ref --tags -d`
            refs.set(ref + '^{}', oid);
        } else {
            // This is an oid followed by the ref name
            const i = line.indexOf(' ');
            const oid = line.slice(0, i);
            ref = line.slice(i + 1);
            refs.set(ref, oid);
        }
    }

    return refs;
}
