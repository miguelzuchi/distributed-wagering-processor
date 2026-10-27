import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/** Explicit replacement point for an OIDC-backed provider guard. */
@Injectable()
export class NoAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
