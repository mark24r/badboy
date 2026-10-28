import { useEffect, useRef } from 'react';
import { LoaderCircle, LockKeyhole, Sparkles } from 'lucide-react';

export const POOL_POSITION_COUNT = 25;
export const POINTER_TICK_ANGLE = 360 / POOL_POSITION_COUNT;

// The three coloured areas are the exact starting-pool proportions: 1 / 25,
// 4 / 25 and 20 / 25. Small rim ticks divide those areas into 25 positions.
export const WHEEL_SEGMENTS = [
  { outcome: 'win', label: 'REGULAR TICKET', start: 0, angle: POINTER_TICK_ANGLE, fill: '#d5ad43', text: '#0b0906' },
  { outcome: 'free-spin', label: 'FREE SPIN', start: POINTER_TICK_ANGLE, angle: POINTER_TICK_ANGLE * 4, fill: '#f4ede0', text: '#0b0906' },
  { outcome: 'no-win', label: 'NO WIN', start: POINTER_TICK_ANGLE * 5, angle: POINTER_TICK_ANGLE * 20, fill: '#292116', text: '#f4ede0' },
];

export function targetRotationForOutcome(outcome) {
  const segment = WHEEL_SEGMENTS.find((item) => item.outcome === outcome) || WHEEL_SEGMENTS[2];
  return (360 - (segment.start + segment.angle / 2) + 360) % 360;
}

function point(radius, angle) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: 160 + radius * Math.cos(radians),
    y: 160 + radius * Math.sin(radians),
  };
}

function segmentPath(segment) {
  const start = point(145, -90 + segment.start);
  const end = point(145, -90 + segment.start + segment.angle);
  const largeArc = segment.angle > 180 ? 1 : 0;
  return `M 160 160 L ${start.x} ${start.y} A 145 145 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

function easeSpin(progress) {
  return progress < 0.5
    ? 4 * Math.pow(progress, 3)
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

export default function Wheel({ rotation, duration, spinning, canSpin, bonus, closed, onSpin }) {
  const rotorRef = useRef(null);
  const pointerRef = useRef(null);
  const currentRotation = useRef(rotation);

  useEffect(() => {
    const rotor = rotorRef.current;
    const pointer = pointerRef.current;
    if (!rotor) return undefined;

    let frame = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finish = () => {
      currentRotation.current = rotation;
      rotor.style.transform = `rotate(${rotation}deg)`;
      if (pointer) pointer.style.transform = 'translateX(-50%) rotate(0deg)';
    };

    if (!spinning || currentRotation.current === rotation || duration <= 0) {
      finish();
      return undefined;
    }

    const from = currentRotation.current;
    const distance = rotation - from;
    const startedAt = performance.now();
    let previousTick = Math.floor(from / POINTER_TICK_ANGLE);
    let pointerKick = 0;

    const animate = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const nextRotation = from + distance * easeSpin(progress);
      currentRotation.current = nextRotation;
      rotor.style.transform = `rotate(${nextRotation}deg)`;

      if (pointer && !reducedMotion) {
        const tick = Math.floor(nextRotation / POINTER_TICK_ANGLE);
        if (tick !== previousTick) {
          pointerKick = -Math.min(20, 10 + Math.abs(tick - previousTick) * 2);
          previousTick = tick;
        }
        pointerKick *= 0.68;
        if (Math.abs(pointerKick) < 0.15) pointerKick = 0;
        pointer.style.transform = `translateX(-50%) rotate(${pointerKick}deg)`;
      }

      if (progress < 1) frame = requestAnimationFrame(animate);
      else finish();
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [rotation, duration, spinning]);

  return (
    <div className={`wheel-wrap ${spinning ? 'is-spinning' : ''} ${canSpin && !spinning ? 'is-ready' : ''}`}>
      <div className="wheel-pointer" ref={pointerRef} aria-hidden="true">
        <span />
      </div>
      <div
        className="wheel-rotor"
        ref={rotorRef}
        style={{
          transform: `rotate(${rotation}deg)`,
          transition: 'none',
        }}
        aria-hidden="true"
      >
        <svg viewBox="0 0 320 320" className="wheel-svg">
          <circle cx="160" cy="160" r="154" fill="#0b0906" />
          <circle cx="160" cy="160" r="148" fill="#f4ede0" />
          {WHEEL_SEGMENTS.map((segment) => {
            const midpoint = segment.start + segment.angle / 2;
            const label = point(segment.outcome === 'win' ? 102 : 101, -90 + midpoint);
            let labelRotation = midpoint + 90;
            if (labelRotation > 90 && labelRotation < 270) labelRotation += 180;
            return (
              <g key={segment.outcome} data-outcome={segment.outcome}>
                <path d={segmentPath(segment)} fill={segment.fill} stroke="#0b0906" strokeWidth="1.2" />
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(${labelRotation} ${label.x} ${label.y})`}
                  fill={segment.text}
                  fontSize={segment.outcome === 'win' ? '7.5' : segment.outcome === 'free-spin' ? '11' : '13'}
                  fontWeight="900"
                  letterSpacing={segment.outcome === 'win' ? '0.6' : '1.2'}
                  fontFamily="Inter, sans-serif"
                >
                  {segment.label}
                </text>
              </g>
            );
          })}
          <circle cx="160" cy="160" r="145" fill="none" stroke="#0b0906" strokeWidth="3" />
          <circle cx="160" cy="160" r="62" fill="#0b0906" stroke="#f4ede0" strokeWidth="3" />
          {Array.from({ length: POOL_POSITION_COUNT }, (_, index) => {
            const dot = point(151, -90 + index * POINTER_TICK_ANGLE);
            return <circle key={index} cx={dot.x} cy={dot.y} r="1.9" fill={index < 5 ? '#d5ad43' : '#f4ede0'} />;
          })}
        </svg>
      </div>
      <button
        type="button"
        className={`wheel-hub ${bonus && canSpin ? 'is-bonus' : ''}`}
        onClick={onSpin}
        disabled={spinning || closed}
        aria-label={closed ? 'Drop closed' : canSpin ? `${bonus ? 'Use your free spin' : 'Spin your paid entry'} now` : 'Enter the giveaway for 500 Kenyan shillings'}
      >
        {spinning ? (
          <>
            <LoaderCircle size={23} className="spin-icon" />
            <span>LOCKED</span>
          </>
        ) : closed ? (
          <>
            <LockKeyhole size={22} />
            <span>CLOSED</span>
          </>
        ) : canSpin ? (
          <>
            <Sparkles size={23} />
            <span>{bonus ? 'FREE SPIN' : 'SPIN'}</span>
          </>
        ) : (
          <>
            <span className="hub-enter">ENTER</span>
            <span className="hub-price">KES 500</span>
          </>
        )}
      </button>
    </div>
  );
}
