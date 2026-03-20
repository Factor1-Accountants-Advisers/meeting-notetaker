export default function LoginPage() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Meeting Note-Taker</h1>
        <p className="text-gray-600 mb-6">Sign in with your Microsoft account to continue.</p>
        <button
          disabled
          className="bg-blue-600 text-white px-6 py-2.5 rounded-md font-medium opacity-50 cursor-not-allowed"
        >
          Sign in with Microsoft
        </button>
        <p className="mt-4 text-xs text-gray-400">
          Azure AD integration coming soon. Using dev bypass.
        </p>
      </div>
    </div>
  );
}
