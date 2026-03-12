interface Env {
  SERVER_ADDRESS: string;
  INBOXES: KVNamespace;
}

// Cloudflare Email Workers types
interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}
