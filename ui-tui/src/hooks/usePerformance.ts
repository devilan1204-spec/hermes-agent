import { useRef, useCallback, useState, useEffect, useLayoutEffect } from 'react';

/**
 * Custom hook for performance monitoring
 * Helps track and log performance metrics for components
 */
export function usePerformanceMonitor(componentName: string, options = { 
  logToConsole: false,
  thresholdMs: 16 // 60fps threshold
}) {
  const renderCountRef = useRef(0);
  const renderTimesRef = useRef<number[]>([]);
  const lastRenderTimeRef = useRef(performance.now());
  const [metrics, setMetrics] = useState({
    averageRenderTime: 0,
    totalRenders: 0,
    slowRenders: 0
  });

  // Measure start of render cycle
  useEffect(() => {
    const startTime = performance.now();
    
    return () => {
      const endTime = performance.now();
      const renderTime = endTime - startTime;
      
      renderCountRef.current += 1;
      renderTimesRef.current.push(renderTime);
      
      // Keep only the last 100 measurements
      if (renderTimesRef.current.length > 100) {
        renderTimesRef.current.shift();
      }
      
      // Calculate average render time
      const average = renderTimesRef.current.reduce((sum, time) => sum + time, 0) / 
                      renderTimesRef.current.length;
      
      // Count slow renders
      const slowRenders = renderTimesRef.current.filter(time => time > options.thresholdMs).length;
      
      // Update metrics
      setMetrics({
        averageRenderTime: average,
        totalRenders: renderCountRef.current,
        slowRenders
      });
      
      if (options.logToConsole && renderTime > options.thresholdMs) {
        console.log(
          `[PERF] ${componentName} render: ${renderTime.toFixed(2)}ms ` +
          `(avg: ${average.toFixed(2)}ms, slow: ${slowRenders}/${renderCountRef.current})`
        );
      }
      
      lastRenderTimeRef.current = endTime;
    };
  });

  // Function to measure specific operations
  const measureOperation = useCallback((operationName: string, fn: () => void) => {
    const start = performance.now();
    fn();
    const duration = performance.now() - start;
    
    if (options.logToConsole && duration > options.thresholdMs) {
      console.log(`[PERF] ${componentName}.${operationName}: ${duration.toFixed(2)}ms`);
    }
    
    return duration;
  }, [componentName, options.logToConsole, options.thresholdMs]);

  return { 
    metrics,
    measureOperation,
    logEvent: (event: string, durationMs?: number) => {
      if (options.logToConsole) {
        const message = durationMs 
          ? `[PERF] ${componentName}.${event}: ${durationMs.toFixed(2)}ms`
          : `[PERF] ${componentName}.${event}`;
        console.log(message);
      }
    }
  };
}

/**
 * Enhanced version of useVirtualHistory with better performance characteristics
 * Uses the same API as the original but with optimizations for large message lists
 */
export function useEnhancedVirtualHistory(
  scrollRef: any,
  items: readonly { key: string }[],
  columns: number,
  options = {}
) {
  // Core state
  const nodesRef = useRef(new Map<string, unknown>());
  const heightsRef = useRef(new Map<string, number>());
  const refsMap = useRef(new Map<string, (el: unknown) => void>());
  const [version, setVersion] = useState(0);
  
  // Performance tracking
  const measureTime = useRef({
    offsetCalculation: 0,
    heightUpdate: 0,
    rangeCalculation: 0
  });
  
  // Default options
  const {
    estimate = 4,
    overscan = 40,
    maxMounted = 260,
    coldStartCount = 40,
    logPerformance = false
  } = options;
  
  // Width change handling with scaling
  const prevColumns = useRef(columns);
  const skipMeasurement = useRef(false);
  const prevRange = useRef<null | readonly [number, number]>(null);
  const freezeRenders = useRef(0);
  
  // Handle column width changes - scale heights to avoid full remeasurement
  if (prevColumns.current !== columns && prevColumns.current > 0 && columns > 0) {
    const ratio = prevColumns.current / columns;
    prevColumns.current = columns;
    
    const start = performance.now();
    
    for (const [k, h] of heightsRef.current) {
      heightsRef.current.set(k, Math.max(1, Math.round(h * ratio)));
    }
    
    if (logPerformance) {
      console.log(`[PERF] Height scaling: ${(performance.now() - start).toFixed(2)}ms`);
    }
    
    skipMeasurement.current = true;
    freezeRenders.current = 2; // Freeze for 2 renders to allow memos to stabilize
  }
  
  // Track scroll position and viewport
  const metricsRef = useRef({ 
    sticky: true, 
    top: 0, 
    viewportHeight: 0,
    scrollTop: 0,
    pendingDelta: 0
  });
  
  // Update scroll metrics whenever the scroll position changes
  useEffect(() => {
    if (!scrollRef.current) return;
    
    const updateMetrics = () => {
      const s = scrollRef.current;
      if (!s) return;
      
      metricsRef.current = {
        sticky: s.isSticky?.() ?? true,
        top: Math.max(0, s.getScrollTop?.() ?? 0),
        viewportHeight: Math.max(0, s.getViewportHeight?.() ?? 0),
        scrollTop: Math.max(0, s.getScrollTop?.() ?? 0),
        pendingDelta: s.getPendingDelta?.() ?? 0
      };
      
      // Force update if we need to recalculate visible range
      setVersion(v => v + 1);
    };
    
    // Initial update
    updateMetrics();
    
    // Subscribe to scroll events if supported
    const unsubscribe = scrollRef.current.subscribe?.(updateMetrics) ?? (() => {});
    
    return unsubscribe;
  }, [scrollRef.current]);
  
  // Clean up stale items
  useEffect(() => {
    const keep = new Set(items.map(i => i.key));
    let dirty = false;
    
    for (const k of heightsRef.current.keys()) {
      if (!keep.has(k)) {
        heightsRef.current.delete(k);
        nodesRef.current.delete(k);
        refsMap.current.delete(k);
        dirty = true;
      }
    }
    
    if (dirty) {
      setVersion(v => v + 1);
    }
  }, [items]);
  
  // Calculate offsets based on cached heights - memoized to avoid recalculation
  const offsets = React.useMemo(() => {
    void version; // Depends on version to trigger recalculation
    
    const start = performance.now();
    const out = new Array<number>(items.length + 1).fill(0);
    
    for (let i = 0; i < items.length; i++) {
      out[i + 1] = out[i]! + Math.max(1, Math.floor(heightsRef.current.get(items[i]!.key) ?? estimate));
    }
    
    measureTime.current.offsetCalculation = performance.now() - start;
    if (logPerformance && measureTime.current.offsetCalculation > 5) {
      console.log(`[PERF] Offset calculation: ${measureTime.current.offsetCalculation.toFixed(2)}ms`);
    }
    
    return out;
  }, [estimate, items, version]);
  
  // Calculate visible range
  const rangeStart = React.useMemo(() => {
    const start = performance.now();
    
    const n = items.length;
    const total = offsets[n] ?? 0;
    const metrics = metricsRef.current;
    const { top, viewportHeight, sticky } = metrics;
    
    // Handle frozen range for width changes
    const frozenRange =
      freezeRenders.current > 0 && prevRange.current && prevRange.current[0] < n ? prevRange.current : null;
    
    let startIdx = 0;
    let endIdx = n;
    
    if (frozenRange) {
      startIdx = frozenRange[0];
      endIdx = Math.min(frozenRange[1], n);
    } else if (n > 0) {
      if (viewportHeight <= 0) {
        startIdx = Math.max(0, n - coldStartCount);
      } else {
        // Binary search for start and end indices
        let lo = 0;
        let hi = n;
        
        // Find start index (first item below top - overscan)
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          offsets[mid]! <= Math.max(0, top - overscan) ? (lo = mid + 1) : (hi = mid);
        }
        startIdx = Math.max(0, lo - 1);
        
        // Find end index (first item below top + viewportHeight + overscan)
        lo = startIdx;
        hi = n;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          offsets[mid]! <= top + viewportHeight + overscan ? (lo = mid + 1) : (hi = mid);
        }
        endIdx = lo;
      }
    }
    
    // Limit number of mounted items
    if (endIdx - startIdx > maxMounted) {
      sticky ? (startIdx = Math.max(0, endIdx - maxMounted)) : (endIdx = Math.min(n, startIdx + maxMounted));
    }
    
    // Update freeze counter
    if (freezeRenders.current > 0) {
      freezeRenders.current--;
    } else {
      prevRange.current = [startIdx, endIdx];
    }
    
    measureTime.current.rangeCalculation = performance.now() - start;
    if (logPerformance && measureTime.current.rangeCalculation > 5) {
      console.log(`[PERF] Range calculation: ${measureTime.current.rangeCalculation.toFixed(2)}ms`);
    }
    
    return { start: startIdx, end: endIdx };
  }, [items.length, offsets, version, overscan, maxMounted, coldStartCount]);
  
  // Create measurement ref callback
  const measureRef = useCallback((key: string) => {
    let fn = refsMap.current.get(key);
    
    if (!fn) {
      fn = (el: unknown) => (el ? nodesRef.current.set(key, el) : nodesRef.current.delete(key));
      refsMap.current.set(key, fn);
    }
    
    return fn;
  }, []);
  
  // Update height measurements after render
  useLayoutEffect(() => {
    const start = performance.now();
    let dirty = false;
    
    if (skipMeasurement.current) {
      skipMeasurement.current = false;
    } else {
      for (let i = rangeStart.start; i < rangeStart.end; i++) {
        const k = items[i]?.key;
        
        if (!k) {
          continue;
        }
        
        const node = nodesRef.current.get(k) as any;
        const h = Math.ceil(node?.yogaNode?.getComputedHeight?.() ?? 0);
        
        if (h > 0 && heightsRef.current.get(k) !== h) {
          heightsRef.current.set(k, h);
          dirty = true;
        }
      }
    }
    
    if (dirty) {
      setVersion(v => v + 1);
    }
    
    measureTime.current.heightUpdate = performance.now() - start;
    if (logPerformance && measureTime.current.heightUpdate > 5) {
      console.log(`[PERF] Height update: ${measureTime.current.heightUpdate.toFixed(2)}ms`);
    }
  }, [rangeStart.end, rangeStart.start, items]);
  
  // Return the same API as the original hook for compatibility
  return {
    bottomSpacer: Math.max(0, offsets[items.length] ?? 0 - (offsets[rangeStart.end] ?? 0)),
    end: rangeStart.end,
    measureRef,
    offsets,
    start: rangeStart.start,
    topSpacer: offsets[rangeStart.start] ?? 0
  };
}

/**
 * Hook to throttle scroll events and track scroll performance
 */
export function useScrollPerformance(componentName: string, options = { 
  logToConsole: false,
  sampleRate: 0.1, // Only log 10% of scroll events to reduce noise
  thresholdMs: 16
}) {
  const scrollCountRef = useRef(0);
  const scrollTimesRef = useRef<number[]>([]);
  const isScrollingRef = useRef(false);
  const scrollStartTimeRef = useRef(0);
  const scrollThrottleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const onScrollStart = useCallback(() => {
    if (!isScrollingRef.current) {
      isScrollingRef.current = true;
      scrollStartTimeRef.current = performance.now();
      
      if (options.logToConsole) {
        console.log(`[SCROLL] ${componentName} scroll started`);
      }
    }
  }, [componentName, options.logToConsole]);

  const onScrollEnd = useCallback(() => {
    if (isScrollingRef.current) {
      const duration = performance.now() - scrollStartTimeRef.current;
      scrollTimesRef.current.push(duration);
      
      // Keep array at reasonable size
      if (scrollTimesRef.current.length > 50) {
        scrollTimesRef.current.shift();
      }
      
      isScrollingRef.current = false;
      
      if (options.logToConsole && Math.random() < options.sampleRate) {
        const avg = scrollTimesRef.current.reduce((sum, time) => sum + time, 0) / 
                   scrollTimesRef.current.length;
                   
        console.log(
          `[SCROLL] ${componentName} scroll ended: ${duration.toFixed(2)}ms ` +
          `(avg: ${avg.toFixed(2)}ms)`
        );
      }
    }
  }, [componentName, options.logToConsole, options.sampleRate]);

  const onScroll = useCallback(() => {
    scrollCountRef.current += 1;
    
    // Start scrolling tracking if not already
    onScrollStart();
    
    // Reset the scroll end timer
    if (scrollThrottleTimerRef.current) {
      clearTimeout(scrollThrottleTimerRef.current);
    }
    
    // Set timer to detect when scrolling stops
    scrollThrottleTimerRef.current = setTimeout(() => {
      onScrollEnd();
    }, 150); // Consider scrolling stopped after 150ms of inactivity
    
  }, [onScrollStart, onScrollEnd]);

  // Clean up
  useEffect(() => {
    return () => {
      if (scrollThrottleTimerRef.current) {
        clearTimeout(scrollThrottleTimerRef.current);
      }
    };
  }, []);

  return { onScroll };
}