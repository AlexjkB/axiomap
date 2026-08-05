/**
 * A stylesheet import is a bundler instruction, not a module with an API. Vite
 * turns `import './styles.css'` into a link in the built HTML; TypeScript needs
 * telling that the specifier resolves to nothing worth typing.
 */
declare module '*.css';
