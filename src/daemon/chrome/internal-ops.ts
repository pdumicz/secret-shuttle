// src/daemon/chrome/internal-ops.ts
export interface FieldDescriptor {
  tag: string;
  type?: string;
  name?: string;
  id?: string;
  editable: boolean;
}

export interface CaptureResult {
  value: string;
  domain: string;
  target_id: string;
  field: FieldDescriptor;
  field_fingerprint: string;
}

export interface InjectResult {
  domain: string;
  target_id: string;
  field: FieldDescriptor;
  field_fingerprint: string;
}

export interface BrowserOps {
  readonly available: boolean;
  captureFocused(): Promise<CaptureResult>;
  captureSelection(): Promise<CaptureResult>;
  injectFocused(value: string): Promise<InjectResult>;
  readFocusedFingerprintAndDomain(): Promise<Omit<CaptureResult, "value">>;
  currentDomainAndTarget(): Promise<{ domain: string; target_id: string }>;
}
