import { renderToString } from 'react-dom/server';
import { Button } from '@base-ui/react/button';
import React from 'react';

const Link = React.forwardRef((props, ref) => React.createElement('a', { ref, ...props }));

console.log(renderToString(React.createElement(Button, { nativeButton: false, render: React.createElement(Link, { href: '/' }) }, 'Test')));
