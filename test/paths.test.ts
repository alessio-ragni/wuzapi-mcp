import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerToHost, hostToContainer, isWindowsPath } from '../src/paths.ts';

// Invented paths and names only.

test('isWindowsPath recognises drive letters and UNC paths', () => {
  assert.equal(isWindowsPath('C:\\Users\\sample'), true);
  assert.equal(isWindowsPath('d:/Users/sample'), true);
  assert.equal(isWindowsPath('\\\\server\\share\\x'), true);
  assert.equal(isWindowsPath('/Users/sample'), false);
  assert.equal(isWindowsPath('relative/path'), false);
});

test('posix root maps to the mount', () => {
  assert.equal(hostToContainer('/Users/sample/Documents/a.pdf', '/Users/sample', '/files'), '/files/Documents/a.pdf');
  assert.equal(hostToContainer('/Users/sample', '/Users/sample', '/files'), '/files');
  assert.equal(hostToContainer('/Users/sample/', '/Users/sample/', '/files'), '/files');
  assert.equal(hostToContainer('/Users/sample/./Documents/../a.pdf', '/Users/sample', '/files'), '/files/a.pdf');
});

test('posix paths outside the root are refused', () => {
  assert.equal(hostToContainer('/Users/other/a.pdf', '/Users/sample', '/files'), undefined);
  assert.equal(hostToContainer('/Users/sample2/a.pdf', '/Users/sample', '/files'), undefined);
  assert.equal(hostToContainer('/Users/sample/../other/a.pdf', '/Users/sample', '/files'), undefined);
  assert.equal(hostToContainer('/etc/passwd', '/Users/sample', '/files'), undefined);
});

test('identity when root and mount are the same (running outside Docker)', () => {
  assert.equal(hostToContainer('/home/sample/x/y.txt', '/home/sample', '/home/sample'), '/home/sample/x/y.txt');
  assert.equal(containerToHost('/home/sample/x/y.txt', '/home/sample', '/home/sample'), '/home/sample/x/y.txt');
});

test('Windows root with backslashes', () => {
  assert.equal(hostToContainer('C:\\Users\\sample\\Documents\\a.pdf', 'C:\\Users\\sample', '/files'), '/files/Documents/a.pdf');
  assert.equal(hostToContainer('C:\\Users\\sample', 'C:\\Users\\sample', '/files'), '/files');
  assert.equal(hostToContainer('C:\\Users\\sample\\', 'C:\\Users\\sample', '/files'), '/files');
});

test('Windows root with forward slashes and mixed separators', () => {
  assert.equal(hostToContainer('C:/Users/sample/Documents/a.pdf', 'C:\\Users\\sample', '/files'), '/files/Documents/a.pdf');
  assert.equal(hostToContainer('C:\\Users\\sample/Documents\\a.pdf', 'C:/Users/sample', '/files'), '/files/Documents/a.pdf');
  assert.equal(hostToContainer('C:\\Users\\sample\\Documents\\a.pdf', 'C:\\Users\\sample\\', '/files'), '/files/Documents/a.pdf');
});

test('Windows comparison is case-insensitive', () => {
  assert.equal(hostToContainer('c:\\users\\SAMPLE\\Pictures\\p.jpg', 'C:\\Users\\sample', '/files'), '/files/Pictures/p.jpg');
});

test('Windows paths outside the root are refused, including prefix-but-not-boundary', () => {
  assert.equal(hostToContainer('C:\\Users\\sample2\\a.pdf', 'C:\\Users\\sample', '/files'), undefined);
  assert.equal(hostToContainer('D:\\Users\\sample\\a.pdf', 'C:\\Users\\sample', '/files'), undefined);
  assert.equal(hostToContainer('C:\\Users\\sample\\..\\other\\a.pdf', 'C:\\Users\\sample', '/files'), undefined);
  assert.equal(hostToContainer('C:\\Windows\\system32\\x', 'C:\\Users\\sample', '/files'), undefined);
});

test('container paths map back to host paths in the host style', () => {
  assert.equal(containerToHost('/downloads/abc-photo.jpg', '/downloads', '/Users/sample/Downloads/wuzapi-mcp'), '/Users/sample/Downloads/wuzapi-mcp/abc-photo.jpg');
  assert.equal(containerToHost('/downloads/abc-photo.jpg', '/downloads', 'C:\\Users\\sample\\Downloads\\wuzapi-mcp'), 'C:\\Users\\sample\\Downloads\\wuzapi-mcp\\abc-photo.jpg');
  assert.equal(containerToHost('/downloads', '/downloads', 'C:\\Users\\sample\\Downloads'), 'C:\\Users\\sample\\Downloads');
  assert.equal(containerToHost('/data/downloads/x', '/downloads', '/Users/sample/Downloads'), '/data/downloads/x');
});

test('round trip on Windows', () => {
  const host = 'C:\\Users\\sample\\Documents\\report.docx';
  const inside = hostToContainer(host, 'C:\\Users\\sample', '/files');
  assert.equal(inside, '/files/Documents/report.docx');
  assert.equal(containerToHost(inside!, '/files', 'C:\\Users\\sample'), host);
});
