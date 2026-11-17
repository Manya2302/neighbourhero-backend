const allowedAudiences = [
  process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
  process.env.GOGGLE_Client_ID,
  process.env.GOOGLE_CLIENT_ID,
].filter(Boolean);

export async function verifyGoogleIdToken(idToken) {
  if (!idToken) throw new Error('Missing Google token');
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  );
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error('Google sign-in could not be verified');
  }
  if (allowedAudiences.length && !allowedAudiences.includes(data.aud)) {
    throw new Error('Google sign-in is not for this app');
  }
  if (!data.email) {
    throw new Error('Google did not return an email');
  }
  return {
    googleId: data.sub,
    email: data.email,
    name: data.name || data.email.split('@')[0],
    picture: data.picture || null,
  };
}
