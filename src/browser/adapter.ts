export type FocusedFieldSource = "focused-field" | "selection";
export type FocusedFieldTarget = "focused-field";

export interface FocusedFieldRead {
  value: string;
  source: FocusedFieldSource;
  domain: string;
  field: {
    tag: string;
    type?: string;
    name?: string;
    id?: string;
    editable: boolean;
  };
}

export interface FocusedFieldWrite {
  injected: true;
  domain: string;
  field: {
    tag: string;
    type?: string;
    name?: string;
    id?: string;
    editable: boolean;
  };
}

export interface BrowserAdapter {
  read(source: FocusedFieldSource): Promise<FocusedFieldRead>;
  write(value: string): Promise<FocusedFieldWrite>;
  currentDomain(): Promise<string>;
}
