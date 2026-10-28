import { useEffect, useRef } from 'react';
import { LoaderCircle, LockKeyhole, Sparkles } from 'lucide-react';

const SEGMENTS = 5;
const SEGMENT_ANGLE = 360 / SEGMENTS;

function point(radius, angle) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: 160 + radius * Math.cos(radians),
    y: 160 + radius * Math.sin(radians),
  };
}

function segmentPath(index) {
  const start = point(145, -90 + index * SEGMENT_ANGLE);
  const end = point(145, -90 + (index + 1) * SEGMENT_ANGLE);
  return `M 160 160 L ${start.x} ${start.y} A 145 145 0 0 1 ${end.x} ${end.y} Z`;
}

function easeSpin(progress) {
  return progress < 0.5
    ? 4 * Math.pow(progress, 3)
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

export default function Wheel({ rotation, duration, spinning, canSpin, closed, onSpin }) {
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
    let previousSegment = Math.floor(from / SEGMENT_ANGLE);
    let pointerKick = 0;

    const animate = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const nextRotation = from + distance * easeSpin(progress);
      currentRotation.current = nextRotation;
      rotor.style.transform = `rotate(${nextRotation}deg)`;

      if (pointer && !reducedMotion) {
        const segment = Math.floor(nextRotation / SEGMENT_ANGLE);
        if (segment !== previousSegment) {
          pointerKick = -Math.min(20, 10 + Math.abs(segment - previousSegment) * 2);
          previousSegment = segment;
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
          {Array.from({ length: SEGMENTS }, (_, index) => {
            const midpoint = -90 + index * SEGMENT_ANGLE + SEGMENT_ANGLE / 2;
            const label = point(101, midpoint);
            const isWinner = index === 0;
            const fill = isWinner ? '#d5ad43' : index % 2 === 0 ? '#f4ede0' : '#292116';
            return (
              <g key={index}>
                <path d={segmentPath(index)} fill={fill} stroke="#0b0906" strokeWidth="1.2" />
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(${midpoint + 90} ${label.x} ${label.y})`}
                  fill={isWinner || index % 2 === 0 ? '#0b0906' : '#f4ede0'}
                  fontSize={isWinner ? '13' : '9'}
                  fontWeight="900"
                  letterSpacing={isWinner ? '1.5' : '1'}
                  fontFamily="Inter, sans-serif"
                >
                  {isWinner ? 'TICKET' : 'NO WIN'}
                </text>
              </g>
            );
          })}
          <circle cx="160" cy="160" r="145" fill="none" stroke="#0b0906" strokeWidth="3" />
          <circle cx="160" cy="160" r="62" fill="#0b0906" stroke="#f4ede0" strokeWidth="3" />
          {Array.from({ length: SEGMENTS }, (_, index) => {
            const dot = point(151, -90 + index * SEGMENT_ANGLE);
            return <circle key={index} cx={dot.x} cy={dot.y} r="2.4" fill={index === 0 ? '#d5ad43' : '#f4ede0'} />;
          })}
        </svg>
      </div>
      <button
        type="button"
        className="wheel-hub"
        onClick={onSpin}
        disabled={spinning || closed}
        aria-label={closed ? 'Drop closed' : canSpin ? 'Spin your paid entry now' : 'Enter the giveaway for 500 Kenyan shillings'}
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
            <span>SPIN</span>
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
