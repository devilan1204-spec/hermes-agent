import React, { useEffect, useRef, useState } from 'react';
import { FixedSizeList as List } from 'react-window';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { MessageData } from '../gatewayTypes';
import { Markdown } from './markdown';
import { themed } from './themed';

// Estimated average height for message rows (will be refined later)
const ESTIMATED_ROW_HEIGHT = 50;

// Overscan count - render this many items above/below the visible area
const OVERSCAN_COUNT = 10;

interface MessageLineProps {
  message: MessageData;
  onRender?: () => void;
  isHighlighted?: boolean;
  expandCode?: boolean;
}

export const MessageLine: React.FC<MessageLineProps> = React.memo(({ 
  message, 
  onRender, 
  isHighlighted = false, 
  expandCode = false 
}) => {
  const theme = useTheme();
  const { role, content } = message;
  
  useEffect(() => {
    onRender?.();
  }, [onRender]);
  
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
  // Custom comparison logic for memoization
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.message.role === nextProps.message.role &&
    prevProps.isHighlighted === nextProps.isHighlighted &&
    prevProps.expandCode === nextProps.expandCode
  );
});

interface MessageContainerProps {
  messages: MessageData[];
  height: number;
  width: number;
  expandCode?: boolean;
  highlightedMessageId?: string;
}

export const VirtualizedMessageContainer: React.FC<MessageContainerProps> = ({
  messages,
  height,
  width,
  expandCode = false,
  highlightedMessageId,
}) => {
  const listRef = useRef<List>(null);
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  
  // Scroll to bottom on new messages
  useEffect(() => {
    if (listRef.current && messages.length > 0) {
      listRef.current.scrollToItem(messages.length - 1);
    }
  }, [messages.length]);
  
  // Record the actual rendered heights for more accurate virtualization
  const handleMessageRender = (id: string, index: number) => {
    // In a real implementation, we would measure DOM nodes here
    // This is a placeholder for the concept
    if (!measuredHeights[id]) {
      setMeasuredHeights(prev => ({
        ...prev,
        [id]: ESTIMATED_ROW_HEIGHT // In reality, we'd measure the actual height
      }));
    }
  };
  
  return (
    <List
      ref={listRef}
      height={height}
      width={width}
      itemCount={messages.length}
      itemSize={ESTIMATED_ROW_HEIGHT}
      overscanCount={OVERSCAN_COUNT}
      style={{ scrollbarGutter: 'stable' }}
    >
      {({ index, style }) => {
        const message = messages[index];
        return (
          <div style={style}>
            <MessageLine
              message={message}
              expandCode={expandCode}
              isHighlighted={message.id === highlightedMessageId}
              onRender={() => handleMessageRender(message.id, index)}
            />
          </div>
        );
      }}
    </List>
  );
};