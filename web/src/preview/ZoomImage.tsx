import { useRef, useState, type PointerEvent, type WheelEvent } from "react";

interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

function clamp(scale: number): number {
  return Math.min(Math.max(scale, 1), 8);
}

export function ZoomImage({ src, alt, onFacts, onSwipe }: { src: string; alt: string; onFacts: (facts: string) => void; onSwipe: (direction: 1 | -1) => void }) {
  const [view, setView] = useState<View>(FIT);
  const img = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ distance: number; scale: number; startX: number; moved: number; lastTap: number }>({ distance: 0, scale: 1, startX: 0, moved: 0, lastTap: 0 });

  const toggle = () => {
    const el = img.current;
    if (view.scale !== 1 || el === null) {
      setView(FIT);
      return;
    }
    setView({ scale: clamp(el.naturalWidth / el.clientWidth) || 2, x: 0, y: 0 });
  };

  const onWheel = (e: WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((v) => {
      const scale = clamp(v.scale * factor);
      return scale === 1 ? FIT : { ...v, scale };
    });
  };

  const down = (e: PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current.startX = e.clientX;
    gesture.current.moved = 0;
    const points = [...pointers.current.values()];
    const [a, b] = points;
    if (a !== undefined && b !== undefined) {
      gesture.current.distance = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.current.scale = view.scale;
    }
  };

  const move = (e: PointerEvent) => {
    const before = pointers.current.get(e.pointerId);
    if (before === undefined) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current.moved = Math.max(gesture.current.moved, Math.abs(e.clientX - gesture.current.startX));
    const [a, b] = [...pointers.current.values()];
    if (a !== undefined && b !== undefined) {
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const scale = clamp((gesture.current.scale * distance) / gesture.current.distance);
      setView((v) => (scale === 1 ? FIT : { ...v, scale }));
    } else if (view.scale > 1) {
      setView((v) => ({ ...v, x: v.x + e.clientX - before.x, y: v.y + e.clientY - before.y }));
    }
  };

  const up = (e: PointerEvent) => {
    const single = pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (!single) return;
    const dx = e.clientX - gesture.current.startX;
    if (view.scale === 1 && e.pointerType === "touch" && Math.abs(dx) > 60) {
      onSwipe(dx < 0 ? 1 : -1);
    } else if (gesture.current.moved < 8) {
      const now = performance.now();
      if (now - gesture.current.lastTap < 300) toggle();
      gesture.current.lastTap = now;
    }
  };

  return (
    <div className="zoom" onWheel={onWheel} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <img
        ref={img}
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        onLoad={(e) => onFacts(`${e.currentTarget.naturalWidth} by ${e.currentTarget.naturalHeight}`)}
      />
    </div>
  );
}
