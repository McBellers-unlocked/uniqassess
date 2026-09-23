/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    // NextAuth / Cognito
    COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID,
    COGNITO_ISSUER: process.env.COGNITO_ISSUER,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    // Persistence
    DATABASE_URL: process.env.DATABASE_URL,
    // AI
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    RECRUIT_CLAUDE_MODEL: process.env.RECRUIT_CLAUDE_MODEL,
    RECRUIT_MAX_TOKENS: process.env.RECRUIT_MAX_TOKENS,
    // Optional — Secrets Manager fallback for the Anthropic key
    APP_REGION: process.env.APP_REGION,
    SECRET_ARN: process.env.SECRET_ARN,
    // Nonsecret lab switch/locator only. SSR fetches the runner key using its IAM role.
    KUBERNETES_LABS_ENABLED: process.env.KUBERNETES_LABS_ENABLED,
    KUBERNETES_LAB_CONFIG_SECRET_ARN: process.env.KUBERNETES_LAB_CONFIG_SECRET_ARN,
  },
  // Ensure scenario HTML exhibits + marking rubric JSONs under infra/recruit
  // are included in the serverless output so readFileSync(process.cwd() + …)
  // works at runtime. In Next.js 14 this lives under `experimental`; it moves
  // to top-level in Next.js 15.
  experimental: {
    outputFileTracingIncludes: {
      "/api/**/*": ["./infra/recruit/**/*"],
      "/assess/**/*": ["./infra/recruit/**/*"],
    },
  },
};

export default nextConfig;
