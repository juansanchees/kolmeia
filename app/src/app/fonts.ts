import { Archivo_Narrow, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

const archivoNarrow = Archivo_Narrow({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-archivo-narrow", display: "swap" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

/** Put on <html>. */
export const fontVars = `${archivoNarrow.variable} ${plexSans.variable} ${plexMono.variable}`;
