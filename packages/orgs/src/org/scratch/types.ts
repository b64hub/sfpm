export interface ScratchOrg {
  auth: {
    alias?: string;
    authUrl?: string;
    email?: string;
    loginUrl?: string;
    password?: string;
    token?: string;
    username: string;
  },
  expiry?: number;
  orgId: string;
  pool?: {
    isScriptExecuted?: boolean;
    status: string,
    tag: string,
    timestamp: number;
  }
  recordId?: string;
}
