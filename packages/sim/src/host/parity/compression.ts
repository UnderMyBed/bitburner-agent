// The game compresses saves with CompressionStream and reads them with DecompressionStream (utils/SaveDataUtils.ts).
// Node runs those on its thread pool in real time, so while a script awaits a save (e.g. ns.singularity.getSaveData),
// virtual time would keep running by however long the machine took: not deterministic. These stand-ins do the same
// gzip work synchronously, when the stream is closed, so no real time passes inside the game.
import { gunzipSync, gzipSync } from "node:zlib";

function bytesOf(chunk: unknown): Uint8Array {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new TypeError("The provided value is not of type '(ArrayBuffer or ArrayBufferView)'");
}

function wholeStreamTransform(convert: (input: Buffer) => Buffer): TransformStream<unknown, Uint8Array> {
  const chunks: Uint8Array[] = [];
  return new TransformStream({
    transform(chunk) {
      chunks.push(bytesOf(chunk));
    },
    flush(controller) {
      controller.enqueue(new Uint8Array(convert(Buffer.concat(chunks))));
    },
  });
}

function streamClass(convert: (input: Buffer) => Buffer) {
  return class {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<unknown>;
    constructor(format: string) {
      if (format !== "gzip")
        throw new TypeError(`Unsupported compression format: '${format}' (only gzip is simulated)`);
      ({ readable: this.readable, writable: this.writable } = wholeStreamTransform(convert));
    }
  };
}

export function installSyncCompression(): void {
  globalThis.CompressionStream = streamClass(gzipSync) as unknown as typeof CompressionStream;
  globalThis.DecompressionStream = streamClass(gunzipSync) as unknown as typeof DecompressionStream;
}
