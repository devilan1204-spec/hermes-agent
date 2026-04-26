import React from 'react';
import { Box, useApp } from 'ink';
import { usePerformanceMonitor } from '../hooks/usePerformance';

/**
 * A fixed window scroller component for efficient rendering of large lists
 * This is a lightweight virtualization component that only renders visible items
 * plus a configurable overscan buffer for smooth scrolling
 */
export const FixedWindowScroller = React.forwardRef(({
  items,
  height,
  width,
  itemHeight = 3, // Average height of each item in terminal rows
  renderItem,
  overscrollItems = 20, // Number of items to render outside visible area
  onScroll,
  initialScrollToEnd = true,
}, ref) => {
  const { stdout } = useApp();
  const { logEvent } = usePerformanceMonitor('FixedWindowScroller', { 
    logToConsole: false 
  });
  
  // Container ref for scroll measurements
  const containerRef = React.useRef(null);
  
  // Track scroll state
  const lastScrollTopRef = React.useRef(0);
  const lastItemsLengthRef = React.useRef(items.length);
  
  // Calculate visible window based on container dimensions
  const [visibleWindow, setVisibleWindow] = React.useState({
    startIndex: Math.max(0, items.length - Math.floor(height / itemHeight) - overscrollItems),
    endIndex: items.length,
    scrollTop: 0
  });
  
  // Expose scroll methods via ref
  React.useImperativeHandle(ref, () => ({
    scrollToItem: (index, align = 'auto') => {
      if (!containerRef.current) return;
      
      const container = containerRef.current;
      const itemOffset = index * itemHeight;
      
      if (align === 'start') {
        container.scrollTop = itemOffset;
      } else if (align === 'end') {
        container.scrollTop = itemOffset - height + itemHeight;
      } else if (align === 'center') {
        container.scrollTop = itemOffset - height / 2 + itemHeight / 2;
      } else {
        // Auto alignment - only scroll if item is outside visible area
        const { scrollTop } = container;
        const visibleBottom = scrollTop + height;
        
        if (itemOffset < scrollTop) {
          container.scrollTop = itemOffset;
        } else if (itemOffset + itemHeight > visibleBottom) {
          container.scrollTop = itemOffset - height + itemHeight;
        }
      }
    },
    
    scrollToTop: () => {
      if (containerRef.current) {
        containerRef.current.scrollTop = 0;
      }
    },
    
    scrollToBottom: () => {
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    },
    
    // Compatibility with ScrollBoxHandle
    getScrollTop: () => containerRef.current?.scrollTop || 0,
    getViewportHeight: () => height,
    getPendingDelta: () => 0,
    isSticky: () => visibleWindow.startIndex === items.length - visibleItemCount,
  }), [height, itemHeight, items.length, visibleWindow.startIndex]);
  
  // Calculate how many items fit in the viewport
  const visibleItemCount = Math.ceil(height / itemHeight);
  
  // Handle scroll events
  const handleScroll = React.useCallback((event) => {
    if (!containerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const scrollTopDiff = Math.abs(scrollTop - lastScrollTopRef.current);
    
    // Only update if we've scrolled a significant amount
    if (scrollTopDiff > (itemHeight / 2)) {
      const totalItems = items.length;
      const visibleItems = Math.floor(clientHeight / itemHeight);
      
      // Calculate the first visible item index
      const firstVisibleItemIndex = Math.floor(scrollTop / itemHeight);
      
      // Calculate start and end indices with overscroll
      const startIndex = Math.max(0, firstVisibleItemIndex - overscrollItems);
      const endIndex = Math.min(
        totalItems, 
        firstVisibleItemIndex + visibleItems + overscrollItems
      );
      
      logEvent(`window-update-${startIndex}-${endIndex}`);
      
      setVisibleWindow({ startIndex, endIndex, scrollTop });
      lastScrollTopRef.current = scrollTop;
      
      // Call external scroll handler if provided
      if (onScroll) {
        onScroll({
          scrollTop,
          scrollHeight,
          clientHeight,
          firstVisibleItemIndex,
          lastVisibleItemIndex: firstVisibleItemIndex + visibleItems,
          isAtTop: scrollTop < itemHeight,
          isAtBottom: scrollTop + clientHeight >= scrollHeight - itemHeight
        });
      }
    }
  }, [items.length, itemHeight, overscrollItems, onScroll, logEvent]);
  
  // Auto-scroll to bottom when new items are added
  React.useEffect(() => {
    if (!containerRef.current) return;
    
    const isNewMessagesAdded = items.length > lastItemsLengthRef.current;
    const isNearBottom = containerRef.current.scrollHeight - containerRef.current.clientHeight - containerRef.current.scrollTop < itemHeight * 3;
    
    if ((isNewMessagesAdded && isNearBottom) || initialScrollToEnd) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      
      // Update the visible window to show the end
      setVisibleWindow({
        startIndex: Math.max(0, items.length - Math.floor(height / itemHeight) - overscrollItems),
        endIndex: items.length,
        scrollTop: containerRef.current.scrollHeight
      });
      
      logEvent('auto-scroll');
    }
    
    lastItemsLengthRef.current = items.length;
  }, [items.length, height, itemHeight, overscrollItems, initialScrollToEnd, logEvent]);
  
  // Get the visible subset of items
  const visibleItems = items.slice(visibleWindow.startIndex, visibleWindow.endIndex);
  
  return (
    <Box
      ref={containerRef}
      overflow="auto"
      width={width}
      height={height}
      onScroll={handleScroll}
      style={{ scrollbarGutter: 'stable' }}
    >
      {/* Top spacer */}
      {visibleWindow.startIndex > 0 && (
        <Box
          width="100%"
          height={visibleWindow.startIndex * itemHeight}
          padding={0}
        />
      )}
      
      {/* Visible items */}
      {visibleItems.map((item, index) => 
        renderItem({
          item,
          index: visibleWindow.startIndex + index,
          isVisible: true
        })
      )}
      
      {/* Bottom spacer */}
      {visibleWindow.endIndex < items.length && (
        <Box
          width="100%"
          height={(items.length - visibleWindow.endIndex) * itemHeight}
          padding={0}
        />
      )}
    </Box>
  );
});

FixedWindowScroller.displayName = 'FixedWindowScroller';

export default FixedWindowScroller;