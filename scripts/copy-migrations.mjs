import {cp, rm} from 'node:fs/promises';
const target = new URL('../dist/src/storage/migrations/', import.meta.url);
await rm(target, {recursive: true, force: true});
await cp(new URL('../src/storage/migrations/', import.meta.url), target, {recursive: true});
