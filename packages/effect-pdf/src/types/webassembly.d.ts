declare global {
  namespace WebAssembly {
    interface Memory {
      readonly buffer: ArrayBuffer;
    }
    interface Table {
      readonly length: number;
    }
    interface Global {
      value: number | bigint;
    }
    type ExportValue =
      | ((...parameters: never[]) => number | bigint | undefined)
      | Memory
      | Table
      | Global;
    type ImportValue = ExportValue | number | bigint;
    type Exports = Readonly<Record<string, ExportValue>>;
    type Imports = Readonly<Record<string, Readonly<Record<string, ImportValue>>>>;
    var Module: {
      readonly prototype: Module;
      new (bytes: Uint8Array<ArrayBuffer>): Module;
    };
    class Instance {
      constructor(module: Module, imports?: Imports);
      readonly exports: Exports;
    }
    function compile(bytes: Uint8Array<ArrayBuffer>): Promise<Module>;
  }
}

export type WasmModule = WebAssembly.Module;
