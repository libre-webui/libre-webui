function parsePorcelainStatus(status) {
  return status
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^\S+\s+(.+)$/);
      return match ? match[1].replace(/^"|"$/g, '') : '';
    })
    .filter(Boolean);
}

module.exports = {
  parsePorcelainStatus,
};
