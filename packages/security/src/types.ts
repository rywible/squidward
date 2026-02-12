export interface SecretHandle {
  id: string;
  name: string;
  provider: string;
  version: number;
  scope: string;
  createdAt: string;
  rotatedAt?: string;
}

export interface EncryptedEnvelope {
  alg: "aes-256-gcm";
  ivB64: string;
  cipherTextB64: string;
  authTagB64: string;
  aadB64?: string;
  keyRef?: string;
}
