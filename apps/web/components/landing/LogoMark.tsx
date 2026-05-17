import Image from "next/image";

type LogoMarkProps = {
  size?: number;
  className?: string;
  draw?: boolean;
  color?: string;
  title?: string;
};

// InstantML mark: 4×4 dot grid — diagonal in Bolt (#1fb877), others in Ink (#0e1116).
export function LogoMark({
  size = 24,
  className = "",
  draw = false,
  // color prop kept for API compatibility; the SVG encodes colors directly
  color: _color,
  title = "InstantML",
}: LogoMarkProps) {
  return (
    <Image
      src="/instantml-mark.svg"
      alt={title}
      width={size}
      height={size}
      className={`${draw ? "logo-draw " : ""}${className}`.trim() || undefined}
      aria-label={title}
    />
  );
}
