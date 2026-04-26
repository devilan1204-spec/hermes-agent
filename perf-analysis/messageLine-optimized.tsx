import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { MessageData } from '../gatewayTypes';
import { Markdown } from './markdown';
import { themed } from './themed';
import { usePerformanceMonitor, useScrollPerformance } from '../hooks/performanceHooks';

// Optimize the MessageLine component with proper memoization
export const MessageLine: React.FC<{
  message: MessageData;
  isHighlighted?: boolean;
  expandCode?: boolean;
}> = React.memo(({ message, isHighlighted = false, expandCode = false }) => {
  const theme = useTheme();
  const { role, content } = message;
  const { logEvent } = usePerformanceMonitor(`MessageLine-${role.substring(0,1)}${message.id?.substring(0,4)}`);
  
  // Skip rendering for empty messages
  if (!content) return null;
  
  const RoleLabel = themed(Text, {
    user: theme.message.user.label,
    assistant: theme.message.assistant.label,
    system: theme.message.system.label,
    tool: theme.message.tool.label,
    function: theme.message.function.label,
  });
  
  const roleStyles = {
    user: theme.message.user.content,
    assistant: theme.message.assistant.content,
    system: theme.message.system.content,
    tool: theme.message.tool.content,
    function: theme.message.function.content,
  };
  
  // Log initial render for performance monitoring
  useEffect(() => {
    logEvent('initial-render');
  }, []);
  
  return (
    <Box 
      flexDirection="column"
      paddingX={0}
      paddingY={0}
      borderStyle={isHighlighted ? 'bold' : undefined}
      borderColor={isHighlighted ? theme.focused : undefined}
    >
      <Box>
        <RoleLabel variant={role as any}>{role}:</RoleLabel>
      </Box>
      <Box marginLeft={1}>
        <Markdown 
          variant={role as keyof typeof roleStyles}
          content={content || ''}
          expandCode={expandCode}
        />
      </Box>
    </Box>
  );
}, (prevProps, nextProps) => {
  // Custom comparison to prevent unnecessary re-renders
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.message.role === nextProps.message.role &&
    prevProps.isHighlighted === nextProps.isHighlighted &&
    prevProps.expandCode === nextProps.expandCode
  );
});

// Fixed window approach for rendering only visible + buffer messages
export const MessageContainer: React.FC<{
  messages: MessageData[];
  scrollBuffer?: number;
  expandCode?: boolean;
  highlightedMessageId?: string;
}> = ({ messages, scrollBuffer = 50, expandCode = false, highlightedMessageId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { onScroll } = useScrollPerformance('MessageContainer');
  const { logEvent } = usePerformanceMonitor('MessageContainer');
  
  // Track visible range
  const [visibleRange, setVisibleRange] = useState({
    start: Math.max(0, messages.length - 30),
    end: messages.length
  });
  
  // Handle scroll events to update visible range
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const scrollRatio = scrollTop / (scrollHeight - clientHeight);
    
    // Calculate visible range based on scroll position
    const totalMessages = messages.length;
    const visibleCount = 30; // Approximate number of visible messages
    const bufferSize = scrollBuffer;
    
    // Calculate start/end indices
    const middleIndex = Math.floor(scrollRatio * totalMessages);
    const halfVisible = Math.floor(visibleCount / 2);
    
    let start = Math.max(0, middleIndex - halfVisible - bufferSize);
    let end = Math.min(totalMessages, middleIndex + halfVisible + bufferSize);
    
    // Special case for start/end of list
    if (scrollRatio < 0.1) {
      start = 0;
      end = Math.min(totalMessages, visibleCount + bufferSize);
    } else if (scrollRatio > 0.9) {
      end = totalMessages;
      start = Math.max(0, totalMessages - visibleCount - bufferSize);
    }
    
    setVisibleRange({ start, end });
    
    // Performance monitoring
    onScroll();
  }, [messages.length, scrollBuffer, onScroll]);
  
  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      const isNearBottom = scrollTop + clientHeight >= scrollHeight - 50;
      
      if (isNearBottom) {
        // Only auto-scroll if we're already near the bottom
        logEvent('auto-scroll');
        containerRef.current.scrollTop = scrollHeight;
        
        // Update visible range to show bottom messages
        setVisibleRange({
          start: Math.max(0, messages.length - 30 - scrollBuffer),
          end: messages.length
        });
      }
    }
  }, [messages.length, scrollBuffer]);
  
  // Log rendering details
  useEffect(() => {
    logEvent(`render-range-${visibleRange.start}-${visibleRange.end}`);
  }, [visibleRange]);

  // Get visible messages subset
  const visibleMessages = messages.slice(visibleRange.start, visibleRange.end);
  
  return (
    <Box 
      flexDirection="column" 
      overflow="auto"
      ref={containerRef}
      onScroll={handleScroll}
      style={{ scrollbarGutter: 'stable both-edges' }}
    >
      {/* Spacer for scroll position */}
      {visibleRange.start > 0 && (
        <Box 
          height={visibleRange.start * 3} 
          width="100%" 
        />
      )}
      
      {/* Visible messages */}
      {visibleMessages.map((message) => (
        <MessageLine 
          key={message.id}
          message={message}
          expandCode={expandCode}
          isHighlighted={message.id === highlightedMessageId}
        />
      ))}
      
      {/* Spacer for remaining messages */}
      {visibleRange.end < messages.length && (
        <Box 
          height={(messages.length - visibleRange.end) * 3}
          width="100%" 
        />
      )}
    </Box>
  );
};