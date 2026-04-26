# TUI Performance Analysis

## Issues Identified

1. **Scrolling lag with large message history**
   - No virtualization or windowing in message rendering
   - Each message re-renders on scroll
   - Complete DOM reconstruction on each render

2. **Input jitter with scrollbar**
   - Composer width changes when scrollbar appears/disappears
   - Layout shifts when scrolling near bottom

3. **Layout thrashing**
   - Multiple successive layout recalculations
   - Excessive style computations in the render loop

## Investigation Areas

### 1. Message Rendering Performance

Current implementation in `messageLine.tsx` renders all messages in the transcript without virtualization. For long sessions, this means:

- Every message is always in the DOM
- Complete re-rendering happens on each state change
- No windowing or culling of off-screen content
- Layout recalculations for entire transcript on each scroll

### 2. Re-rendering Optimization

- No memoization of message components
- No element recycling 
- Each message potentially triggers layout shifts

### 3. Scrollbar Behavior

- Composer width calculation doesn't account for scrollbar presence
- No stable layout constraints

## Proposed Solutions

### 1. Implement Virtualized List for Messages

Add `react-window` or similar virtualization library to render only visible messages:

```tsx
import { FixedSizeList as List } from 'react-window';

// In the component render
<List
  height={viewportHeight}
  itemCount={messages.length}
  itemSize={estimatedRowHeight}
  width="100%"
  overscanCount={5}
>
  {({ index, style }) => (
    <div style={style}>
      <MessageLine message={messages[index]} />
    </div>
  )}
</List>
```

### 2. Memoize Message Components

Use `React.memo` to prevent unnecessary re-renders:

```tsx
const MessageLine = React.memo(({ message, ...props }) => {
  // Component logic
}, (prevProps, nextProps) => {
  // Custom comparison logic
  return prevProps.message.id === nextProps.message.id && 
         prevProps.message.content === nextProps.message.content;
});
```

### 3. Fix Scrollbar Layout Issues

- Add scrollbar-gutter CSS to reserve space for scrollbar
- Stabilize layout with fixed container dimensions

```css
.message-container {
  scrollbar-gutter: stable;
  overflow-y: auto;
}
```

### 4. Add Performance Measurements

Add performance monitoring to identify bottlenecks:

```tsx
useEffect(() => {
  const start = performance.now();
  // Measure key operations
  return () => {
    console.log(`Operation took ${performance.now() - start}ms`);
  };
}, [dependencyArray]);
```

## Implementation Plan

1. Add virtualization for message rendering
2. Implement memo optimization for components
3. Fix scrollbar layout issues
4. Add performance monitoring
5. Optimize re-render triggers
6. Improve scroll restoration

## Resources

- [React Window](https://github.com/bvaughn/react-window)
- [React Virtualized](https://github.com/bvaughn/react-virtualized)
- [CSS Scrollbar Gutter](https://developer.mozilla.org/en-US/docs/Web/CSS/scrollbar-gutter)