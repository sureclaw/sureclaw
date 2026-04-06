// src/providers/auth/types.ts — Auth provider types
import type { IncomingMessage, ServerResponse } from 'node:http';

export type AuthRole = 'admin' | 'user';

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  image?: string;
  role: AuthRole;
}

export interface AuthResult {
  authenticated: boolean;
  user?: AuthUser;
}

/**
 * Auth provider contract.
 *
 * authenticate() returns:
 * - null: "I don't handle this request, try the next provider"
 * - { authenticated: false }: "Credentials recognized but invalid"
 * - { authenticated: true, user }: "Valid, here's the user"
 */
export interface AuthProvider {
  authenticate(req: IncomingMessage): Promise<AuthResult | null>;
  handleRequest?(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}
