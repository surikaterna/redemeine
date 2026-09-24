import { finalizeJoinedReceipt } from './joinedReceiptFinalizer';

const [evidencePath, receiptPath, sha] = process.argv.slice(2);
if (!evidencePath || !receiptPath || !sha) throw new Error('Focused evidence, receipt path and git SHA are required.');
await finalizeJoinedReceipt(evidencePath, receiptPath, sha);
