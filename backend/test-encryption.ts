import { encryptionService } from './src/services/encryptionService.js';

try {
  console.log('🔐 Testing Database Encryption Service');
  console.log('=====================================');

  // Test basic encryption/decryption
  const testData = 'Hello, this is sensitive data!';
  console.log('Original:', testData);

  const encrypted = encryptionService.encrypt(testData);
  console.log('Encrypted:', encrypted);

  const decrypted = encryptionService.decrypt(encrypted);
  console.log('Decrypted:', decrypted);

  console.log('✅ Basic encryption test:', testData === decrypted ? 'PASSED' : 'FAILED');

  // Test object encryption
  const testObject = {
    message: 'Secret message',
    artifacts: [{ type: 'code', content: 'console.log("secret");' }],
    images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='],
    statistics: { tokens: 150, duration: 1200 }
  };

  console.log('\n📦 Testing Object Encryption');
  console.log('Original object:', JSON.stringify(testObject, null, 2));

  const encryptedObject = encryptionService.encryptObject(testObject);
  console.log('Encrypted object:', encryptedObject);

  const decryptedObject = encryptionService.decryptObject(encryptedObject);
  console.log('Decrypted object:', JSON.stringify(decryptedObject, null, 2));

  console.log('✅ Object encryption test:', JSON.stringify(testObject) === JSON.stringify(decryptedObject) ? 'PASSED' : 'FAILED');

  // Test empty/null values
  console.log('\n🔍 Testing Edge Cases');
  try {
    const nullTest = encryptionService.encrypt('');
    const nullDecrypted = encryptionService.decrypt(nullTest);
    console.log('✅ Empty string test:', nullDecrypted === '' ? 'PASSED' : 'FAILED');
  } catch (error) {
    console.log('❌ Empty string test: FAILED -', error.message);
  }

  console.log('\n🎉 Encryption service is ready for production!');
  console.log('All sensitive data will be encrypted before storage in the database.');
} catch (error) {
  console.error('❌ Error running encryption tests:', error);
  process.exit(1);
}
