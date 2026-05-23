import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "InstantML — Training observability that keeps up with your loop";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "80px",
          background:
            "linear-gradient(135deg, #0e1116 0%, #11161d 60%, #0b1612 100%)",
          color: "#f5f4f1",
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 14,
              background: "#1fb877",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0e1116",
              fontSize: 40,
              fontWeight: 700,
            }}
          >
            i
          </div>
          <div style={{ fontSize: 44, fontWeight: 600, letterSpacing: -1 }}>
            InstantML
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              fontSize: 76,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -2,
              maxWidth: 1040,
            }}
          >
            Training observability
            <br />
            <span style={{ color: "#1fb877" }}>that keeps up with your loop.</span>
          </div>
          <div
            style={{
              fontSize: 30,
              color: "#9aa3ad",
              maxWidth: 1040,
              lineHeight: 1.3,
            }}
          >
            Fast where W&amp;B is slow. Cheap where W&amp;B is expensive. Built for
            the way ML teams actually work in 2026.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 24,
            color: "#6b7480",
          }}
        >
          <div>instantml.ai</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: "#1fb877",
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: "#1fb877",
              }}
            />
            Live in 2026
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
