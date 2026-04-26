import React from 'react';
import { Box, useApp } from 'ink';
import { VirtualizedMessageContainer } from './VirtualizedMessageContainer';
import { usePerformanceMonitor } from './performanceHooks';

// This is a proof-of-concept component to demonstrate the performance fixes
export const AppLayoutOptimized: React.FC = () => {
  const { stdout } = useApp();
  const { metrics, measureOperation } = usePerformanceMonitor('AppLayout', { 
    logToConsole: true 
  });
  
  // Calculate viewport dimensions based on terminal size
  const viewportHeight = stdout.rows - 4; // Reserve space for input, etc.
  const viewportWidth = stdout.columns;
  
  // In a real implementation, messages would come from app state
  const messages = React.useMemo(() => {
    return Array(1000).fill(null).map((_, index) => ({
      id: `msg-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `This is message ${index}. It contains some content that might wrap to multiple lines depending on the terminal width. This demonstrates how virtualization can significantly improve performance.`,
    }));
  }, []);
  
  return (
    <Box flexDirection="column" height={stdout.rows} width={stdout.columns}>
      <Box 
        flexDirection="column" 
        height={viewportHeight} 
        width={viewportWidth} 
        overflow="hidden"
        // Use stable scrollbar gutter to prevent layout shifts
        style={{ scrollbarGutter: 'stable' }}
      >
        <VirtualizedMessageContainer 
          messages={messages}
          height={viewportHeight}
          width={viewportWidth}
          expandCode={true}
        />
      </Box>
      
      {/* Performance metrics display */}
      <Box marginTop={1}>
        <Box 
          borderStyle="round" 
          borderColor="yellow" 
          paddingX={1}
          width={viewportWidth}
        >
          <Box flexDirection="column">
            <Box>
              <Box width={25}>Avg render time:</Box>
              <Box>{metrics.averageRenderTime.toFixed(2)}ms</Box>
            </Box>
            <Box>
              <Box width={25}>Total renders:</Box>
              <Box>{metrics.totalRenders}</Box>
            </Box>
            <Box>
              <Box width={25}>Slow renders:</Box>
              <Box>{metrics.slowRenders}</Box>
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};