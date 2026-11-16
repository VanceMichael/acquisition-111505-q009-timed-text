// 时间表达式解释：h:m:s、秒 s、帧 f、tick t。
// 帧率/倍率/tickRate 只采用文档自身声明；缺声明而表达式需要时，不套默认值，
// 返回 unresolved，由上层保留原始表达式并登记问题。
// 所有计算用 BigInt 有理分数，避免浮点累加误差；输出时才转十进制。

const ZERO = { n: 0n, d: 1n };

const add = (a, b) => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const sub = (a, b) => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const mul = (a, b) => ({ n: a.n * b.n, d: a.d * b.d });
const cmp = (a, b) => {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left === right ? 0 : left < right ? -1 : 1;
};

export function toNumber(rational) {
  if (!rational) return null;
  return Math.round(Number(rational.n * 1000000000n / rational.d)) / 1000000000;
}

function parseDecimal(text) {
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  return { n: BigInt(whole) * denominator + BigInt(fraction || '0'), d: denominator || 1n };
}

// 输出文档时间基声明；未声明的字段保持 undefined，绝不补默认值。
export function readTimeBase(ttElement, namespaces) {
  const { TT_PARAMETER } = namespaces;
  const frameRateText = attrLocal(ttElement, TT_PARAMETER, 'frameRate');
  const multiplierText = attrLocal(ttElement, TT_PARAMETER, 'frameRateMultiplier');
  const tickRateText = attrLocal(ttElement, TT_PARAMETER, 'tickRate');
  const base = {
    frameRate: undefined,
    frameRateDeclared: frameRateText !== undefined,
    frameRateMultiplier: undefined,
    tickRate: undefined,
    tickRateDeclared: tickRateText !== undefined,
    effectiveFrameRate: undefined,
    frameDuration: undefined,
    tickDuration: undefined,
    declared: { frameRate: frameRateText, frameRateMultiplier: multiplierText, tickRate: tickRateText },
    notes: [],
  };
  if (frameRateText !== undefined) {
    if (!/^\d+$/.test(frameRateText) || BigInt(frameRateText) === 0n) {
      base.notes.push({ code: 'invalid-timebase', field: 'frameRate', expression: frameRateText });
    } else {
      base.frameRate = BigInt(frameRateText);
    }
  }
  if (multiplierText !== undefined) {
    const match = /^(\d+)\s+(\d+)$/.exec(multiplierText);
    if (!match || BigInt(match[2]) === 0n) {
      base.notes.push({ code: 'invalid-timebase', field: 'frameRateMultiplier', expression: multiplierText });
    } else {
      base.frameRateMultiplier = { n: BigInt(match[1]), d: BigInt(match[2]) };
    }
  }
  if (tickRateText !== undefined) {
    if (!/^\d+$/.test(tickRateText) || BigInt(tickRateText) === 0n) {
      base.notes.push({ code: 'invalid-timebase', field: 'tickRate', expression: tickRateText });
    } else {
      base.tickRate = BigInt(tickRateText);
      base.tickDuration = { n: 1n, d: base.tickRate };
    }
  }
  if (base.frameRate !== undefined) {
    const multiplier = base.frameRateMultiplier ?? { n: 1n, d: 1n };
    base.effectiveFrameRate = mul({ n: base.frameRate, d: 1n }, multiplier);
    base.frameDuration = { n: multiplier.d, d: base.frameRate * multiplier.n };
  }
  return base;
}

function attrLocal(element, ns, local) {
  const found = element.attrs.find(attribute => attribute.local === local && (ns === null || attribute.ns === ns));
  return found ? found.value : undefined;
}

const CLOCK = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const OFFSET = /^(\d+(?:\.\d+)?)(ms|s|f|t)$/;

// 解析单个表达式。返回 { rational } 或 { unresolved: true, reason, expression }。
export function parseExpression(expression, timeBase) {
  const text = expression.trim();
  const clock = CLOCK.exec(text);
  if (clock) {
    const [, hours, minutes, seconds, fraction = ''] = clock;
    const scale = 10n ** BigInt(fraction.length);
    const fractional = { n: BigInt(fraction || '0'), d: scale || 1n };
    const rational = {
      n: (BigInt(hours) * 3600n + BigInt(minutes) * 60n + BigInt(seconds)) * (scale || 1n) + fractional.n,
      d: scale || 1n,
    };
    return { rational };
  }
  const offset = OFFSET.exec(text);
  if (offset) {
    const [, value, unit] = offset;
    if (unit === 'ms') {
      const rational = parseDecimal(value);
      return rational ? { rational: { n: rational.n, d: rational.d * 1000n } } : malformed(text);
    }
    if (unit === 's') {
      const rational = parseDecimal(value);
      return rational ? { rational } : malformed(text);
    }
    if (unit === 'f') {
      if (timeBase.frameDuration === undefined) {
        return { unresolved: true, expression: text, reason: timeBase.frameRateDeclared
          ? 'frame-expression-with-invalid-timebase'
          : 'frame-expression-without-frame-rate' };
      }
      if (!/^\d+$/.test(value)) return malformed(text);
      return { rational: mul({ n: BigInt(value), d: 1n }, timeBase.frameDuration) };
    }
    if (timeBase.tickDuration === undefined) {
      return { unresolved: true, expression: text, reason: timeBase.tickRateDeclared
        ? 'tick-expression-with-invalid-timebase'
        : 'tick-expression-without-tick-rate' };
    }
    if (!/^\d+$/.test(value)) return malformed(text);
    return { rational: mul({ n: BigInt(value), d: 1n }, timeBase.tickDuration) };
  }
  return malformed(text);
}

function malformed(expression) {
  return { unresolved: true, expression, reason: 'unparseable-time-expression' };
}

export { ZERO, add, sub, cmp };
