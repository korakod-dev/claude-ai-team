# word-count

A small Node.js CLI that counts the words in a plain-text file.
Uses only Node.js built-in modules (no external dependencies).

## Usage

```bash
node word-count.js <path-to-text-file>
```

- Prints only the word count to stdout (a single number).
- Errors (missing argument, file not found, etc.) go to stderr with a non-zero exit code.
- A "word" is a run of non-whitespace characters (split on `/\s+/`).
- Input is read as UTF-8.

**Limitation:** Thai has no spaces between words, so Thai text will be undercounted.

## Example

`notes.txt`:

```text
Hello world
  this is   a test
```

Command:

```bash
node word-count.js notes.txt
```

Output:

```text
6
```
