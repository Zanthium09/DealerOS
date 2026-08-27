import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import { PlatformAdminAuthService } from './platform-admin-auth.service';
import { CurrentPlatformSession, PlatformAdminGuard } from './platform-admin.guard';
import { PlatformLoginRateLimitGuard } from './login-rate-limit.guard';
import { HttpResponse, clearSessionCookie, setSessionCookie } from './http';
import { PLATFORM_COOKIE, PLATFORM_TOKEN_TTL_SECONDS, PlatformSession } from './platform-session';

/** Platform operators only (§9A.2). Never mounted under /auth. */
@Controller('admin/auth')
export class PlatformAdminAuthController {
  constructor(private readonly auth: PlatformAdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(PlatformLoginRateLimitGuard)
  async login(
    @Body() body: { email?: unknown; password?: unknown; totp?: unknown },
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const { token, session } = await this.auth.login(body?.email, body?.password, body?.totp);
    setSessionCookie(res, PLATFORM_COOKIE, token, PLATFORM_TOKEN_TTL_SECONDS);
    return { admin: session };
  }

  /** Enrolment step 1 — password-gated, rate limited like the login itself. */
  @Post('mfa/enrol')
  @HttpCode(200)
  @UseGuards(PlatformLoginRateLimitGuard)
  enrol(@Body() body: { email?: unknown; password?: unknown }) {
    return this.auth.beginMfaEnrolment(body?.email, body?.password);
  }

  /** Enrolment step 2 — proves the authenticator, sets mfaEnabled. Issues no session. */
  @Post('mfa/confirm')
  @HttpCode(200)
  @UseGuards(PlatformLoginRateLimitGuard)
  async confirm(@Body() body: { email?: unknown; password?: unknown; totp?: unknown }) {
    await this.auth.confirmMfaEnrolment(body?.email, body?.password, body?.totp);
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: HttpResponse) {
    clearSessionCookie(res, PLATFORM_COOKIE);
    return { ok: true };
  }

  @Get('session')
  @UseGuards(PlatformAdminGuard)
  session(@CurrentPlatformSession() session: PlatformSession) {
    return { admin: session };
  }
}
