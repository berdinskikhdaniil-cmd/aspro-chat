import "./globals.css";

export const metadata = {
  title: "Aspro.Cloud AI Ассистент",
  description: "ИИ-ассистент с доступом к данным CRM",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
