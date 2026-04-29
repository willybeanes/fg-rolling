import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Rolling Metric Chart · FanGraphs Tools',
  description: 'Compare MLB player rolling averages across the season',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
