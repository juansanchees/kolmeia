import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mail libraries run only on the server (E-mail area); load them with Node's require instead of bundling them.
  // A batch of 500 import rows is usually ~100 KB but can reach ~2 MB with long notes: above the 1 MB default.
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  serverExternalPackages: ["nodemailer", "imapflow", "mailparser"],
  // Old URLs from the 3-area move keep working (308); query strings pass through.
  async redirects() {
    return [
      { source: "/pesquisa", destination: "/agentes", permanent: true as const },
      { source: "/pesquisa/:id", destination: "/agentes/pesquisa/:id", permanent: true as const },
      { source: "/empresa", destination: "/configuracoes/empresa", permanent: true as const },
      { source: "/email/caixa", destination: "/configuracoes/caixas", permanent: true as const },
      { source: "/email/bloqueados", destination: "/configuracoes/bloqueados", permanent: true as const },
      { source: "/email/closer", destination: "/leads/closer", permanent: true as const },
      { source: "/email", destination: "/campanhas", permanent: true as const },
      { source: "/email/campanhas/:id", destination: "/campanhas/:id", permanent: true as const },
      { source: "/email/campanhas/:id/revisar", destination: "/campanhas/:id/revisar", permanent: true as const },
      { source: "/email/respostas", destination: "/campanhas/respostas", permanent: true as const },
    ];
  },
};

export default nextConfig;
