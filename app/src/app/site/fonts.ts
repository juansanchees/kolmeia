import { Inter, Space_Grotesk } from "next/font/google";

const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-space-grotesk", display: "swap" });
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter", display: "swap" });

/** Put on the landing root only: the app keeps its own fonts. */
export const landingFonts = `${spaceGrotesk.variable} ${inter.variable}`;
