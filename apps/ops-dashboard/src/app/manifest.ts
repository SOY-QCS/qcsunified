import type { MetadataRoute } from "next";

// Makes the dashboard installable on phones and desktops (PWA).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "QCS Operations",
    short_name: "QCS Ops",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f5f2",
    theme_color: "#df6518",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
