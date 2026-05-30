import type { Metadata } from "next";
import { Onest } from "next/font/google";
import { TRPCReactProvider } from "@/trpc/client";

import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "next-themes";
import { ClerkProvider } from "@clerk/nextjs";



const onest = Onest({
  variable: "--font-onest",
  subsets: ["latin"],
});

const onestMono = Onest({
  variable: "--font-onest-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BUILDO",
  description: "Build and iterate websites with AI using BUILDO.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
    appearance={{
      variables: {
        colorPrimary: "#2563EB",
      }
    }}
    
    >
    <TRPCReactProvider>
      <html lang="en" suppressHydrationWarning>
        <body
          className={`${onest.variable} ${onestMono.variable} font-sans antialiased`}
          suppressHydrationWarning
        >
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            <Toaster />
            {children}
          </ThemeProvider>
        </body>
      </html>
    </TRPCReactProvider>
    </ClerkProvider>
  );
}
