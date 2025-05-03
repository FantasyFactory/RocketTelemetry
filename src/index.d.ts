declare module '*.tsx' {
    const content: any;
    export default content;
  }
  
  interface Window {
    fs: {
      readFile: (path: string, options?: { encoding?: string }) => Promise<any>;
    };
  }