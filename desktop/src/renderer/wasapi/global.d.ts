interface WasapiAPI {
  started: () => void;
  chunk: (bytes: Uint8Array) => void;
  done: () => void;
  error: (message: string) => void;
  onStart: (cb: () => void) => () => void;
  onStop: (cb: () => void) => () => void;
}

interface Window {
  wasapiAPI: WasapiAPI;
}
