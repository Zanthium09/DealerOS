import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentTenantSession, TenantAuthGuard } from './tenant-auth.guard';
import { TenantLoginRateLimitGuard } from './login-rate-limit.guard';
import { HttpResponse, clearSessionCookie, setSessionCookie } from './http';
import { TENANT_COOKIE, TENANT_TOKEN_TTL_SECONDS, TenantSession } from './tenant-session';

/** Tenant users only (§9A.1). Platform admins live at /admin/auth/* and cannot use these. */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(TenantLoginRateLimitGuard)
  async login(
    @Body() body: { email?: unknown; password?: unknown; organizationSlug?: unknown },
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const { token, session } = await this.auth.login(
      body?.email,
      body?.password,
      body?.organizationSlug,
    );
    setSessionCookie(res, TENANT_COOKIE, token, TENANT_TOKEN_TTL_SECONDS);
    return { user: session };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: HttpResponse) {
    clearSessionCookie(res, TENANT_COOKIE);
    return { ok: true };
  }

  @Get('session')
  @UseGuards(TenantAuthGuard)
  session(@CurrentTenantSession() session: TenantSession) {
    return { user: session };
  }
}
