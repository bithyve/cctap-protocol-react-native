const randomStringGenerator = (length) => {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = " ";
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
};

export const pick_nonce = () => {
  const num_of_retry = 3;
  for (let i = 0; i < num_of_retry; i++) {
    rv = randomStringGenerator(USER_NONCE_SIZE);
    const rvSet = new Set(rv.split(""));
    if (rv[0] != rv[-1] || rvSet.length >= 2) return rv;
  }
};
