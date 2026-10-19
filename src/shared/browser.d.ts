export {};
declare global {
  interface Window {
    __sceneReady?: { revision: number; objectIds: string[] };
    __sceneError?: string;
    __fieldworkExport?: (scene: import('./schema.js').Scene) => Promise<number>;
    __fieldworkWriteExportChunk?: (base64: string) => Promise<void>;
  }
}
