export function isInsecureDevMode(): boolean {
  return process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE === "1";
}
