// Type declarations for optional dependencies that may not be installed.
// These modules are dynamically imported with try/catch fallbacks.

declare module 'playwright' {
  const playwright: any;
  export default playwright;
  export const chromium: any;
}

declare module 'keytar' {
  export function getPassword(service: string, account: string): Promise<string | null>;
  export function setPassword(service: string, account: string, password: string): Promise<void>;
  export function deletePassword(service: string, account: string): Promise<boolean>;
  export function findCredentials(service: string): Promise<{ account: string; password: string }[]>;
}
